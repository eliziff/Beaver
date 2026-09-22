import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { isImageDocumentType, toLlmImage } from "../llm/images";
import { acceptsWorkProductOutput } from "mike/shared/court-record-work-products.mjs";
import type { ApplicationScope } from "../applicationError";
import { COURT_PROFILES, COURT_PROFILE_BY_ID, type CourtProfile }
  from "mike/shared/court-record-profiles.mjs";
import { COURT_RECORD_PARTY_CONTACT_FIELDS } from "../courtRecordContract";
import type { CourtRecordsApplication } from "../courtRecordsApplication";
import type { DocumentStore } from "../documentStore";
import { contentTypeForDocumentType } from "../documentTypes";
import type { LibraryStore } from "../libraryStore";
import { renderPdfPage } from "../pdfPageImage";
import { DOCUMENT_OR_DRAFT_PATTERN, parseResourceReference } from "../resourceReferences";
import { safeErrorMessage } from "../safeError";
import { isJsonRecord, trimmedText as text } from "../value";
import type { WorkProductApplication } from "../workProductApplication";
import { workProductEvent, workProductResult } from "./localWorkflowRun";
import { objectSchema, toolText, type BeaverTool, type BeaverToolPolicy } from "./toolRegistry";

const selectableProfiles = COURT_PROFILES.filter((profile) =>
  profile.selectable !== false);
const profileIds = selectableProfiles.map(({ id }) => id);
const coverFields = [...new Set(selectableProfiles.flatMap(({ cover }) =>
  cover.fields.map(({ id }) => id)))];
const partyStyleIds = [...new Set(selectableProfiles.flatMap(({ cover: { partyStyles } }) =>
  partyStyles?.map(({ id }) => id) ?? []))];
const partyGroupIds = [...new Set(selectableProfiles.flatMap(({ cover: { partyStyles } }) =>
  partyStyles?.flatMap(({ groups }) => groups.map(({ id }) => id)) ?? []))];
const slotIds = [...new Set(selectableProfiles.flatMap(({ documentKinds }) =>
  documentKinds.flatMap((slot) => slot.requirement === "forbidden" || slot.generated ? [] : [slot.id])))];
const textField = (maxLength: number) => ({ type: "string", minLength: 1, maxLength });
const partyContact = { type: "object", description: "Contact for a non-filing AP-5 party.",
  properties: Object.fromEntries(COURT_RECORD_PARTY_CONTACT_FIELDS.map((field) =>
    [field, textField(5_000)])), additionalProperties: false };
const partyGroups = { type: "array", maxItems: 50, items: { type: "object", properties: {
  id: { type: "string", enum: partyGroupIds },
  parties: { type: "array", minItems: 1, maxItems: 100, items: { type: "object",
    properties: { id: textField(200), name: textField(5_000), contact: partyContact },
    required: ["id", "name"], additionalProperties: false } },
}, required: ["id", "parties"], additionalProperties: false } };

export const COURT_RECORD_TOOL_PROPERTIES = {
  profile_id: { type: "string", enum: profileIds },
  cover: { type: "object", properties: {
    ...Object.fromEntries(coverFields.map((field) => [field, textField(5_000)])),
    partyStyleId: { type: "string", enum: partyStyleIds }, partyGroups,
    filingPartyIds: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true,
      items: textField(200) },
  }, additionalProperties: false },
  document_id: { type: "string", pattern: DOCUMENT_OR_DRAFT_PATTERN,
    description: "Version-pinned Library document returned by Read." },
  slot_id: { type: "string", enum: slotIds },
  replace_entry_id: { type: "string", minLength: 1 },
  description: textField(1_000),
  date: textField(500),
  exhibit_label: { ...textField(500),
    description: "Use a label returned in the source affidavit's sourceExhibits.labels; otherwise omit it." },
  child_draft_id: { type: "string", minLength: 1 },
  output_role: textField(100),
};

const schema: Tool & BeaverToolPolicy = {
  name: "update_work_product",
  specialist: true,
  sequential: true,
  activity: (input) => input.action === "read" ? "Reading Court Record" : "Updating Court Record",
  description: "Read or update the active Court Record. Read returns its current preset, visible " +
    "cover fields, parties, slots, entries, bindings, and entry_documents: the version-pinned " +
    "document_id to pass to Read or view_page for each bound entry (never the binding's 'latest'). Update fills empty cover or party fields, " +
  "binds one Library document or compatible saved output, and edits its visible description, date, " +
    "or exhibit label. A description-only slot needs no file.",
  annotations: { readOnlyHint: false },
  inputSchema: objectSchema({
    action: { type: "string", enum: ["read", "update"] },
    ...COURT_RECORD_TOOL_PROPERTIES,
  }, ["action"]),
};

type Dependencies = {
  scope: ApplicationScope;
  target: { id: string; revision: number };
  projectId: string | null;
  allowedDocumentIds?: Set<string>;
  library: LibraryStore;
  workProducts: Pick<WorkProductApplication, "get" | "list">;
  courtRecords: Pick<CourtRecordsApplication, "bindOutput" | "updateDraft">;
  documents: Pick<DocumentStore, "metadata">;
  resolveArtifact?(value: string): string | undefined;
  onMutationCommitted(): void;
};

/** Each bound entry as a version-pinned resource the Read and view_page tools accept ("latest" resolved). */
async function entryDocuments(dependencies: Pick<Dependencies, "scope" | "documents">, product: CourtRecordProduct) {
  const bindings = isJsonRecord(product.state.bindings) ? product.state.bindings : {};
  return (await Promise.all(Object.entries(bindings).map(async ([entryId, binding]) => {
    if (!isJsonRecord(binding) || binding.kind !== "document") return [];
    const documentId = String(binding.documentId);
    const versionId = isJsonRecord(binding.version) ? String(binding.version.versionId)
      : (await dependencies.documents.metadata(dependencies.scope, documentId))?.current_version_id;
    return versionId ? [{ entry_id: entryId, document_id: `document://${documentId}/version/${versionId}` }] : [];
  }))).flat();
}

const draftOutputChoices = async (dependencies: Dependencies,
  profile: CourtProfile) =>
  (await dependencies.workProducts.list(dependencies.scope, {
    limit: 100, metadata: false,
  })).flatMap((product) => {
    if (!("outputs" in product) || !product.outputs || typeof product.outputs !== "object" ||
        product.id === dependencies.target.id || product.projectId !== dependencies.projectId) return [];
    const outputs = product.outputs as Record<string, { mimeType?: string }>;
    const profileId = product.kind === "court-record" && "state" in product &&
      typeof product.state.profileId === "string" ? product.state.profileId : undefined;
    const roles = Object.entries(outputs).flatMap(([role, output]) => {
      const fileType = (["pdf", "docx"] as const).find((type) =>
        output.mimeType === contentTypeForDocumentType(type));
      const source = { kind: product.kind, profileId, role };
      return fileType && profile.documentKinds.some((slot) => acceptsWorkProductOutput(slot, source) &&
        (slot.acceptedFormats ?? ["pdf", "docx"]).includes(fileType)) ? [role] : [];
    }).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    return roles.length ? [{ child_draft_id: product.id, title: product.title,
      kind: product.kind, revision: product.revision, output_roles: roles }] : [];
  });

type CourtRecordProduct = Awaited<ReturnType<Dependencies["workProducts"]["get"]>>;
export function courtRecordResult(product: CourtRecordProduct,
  values: Record<string, unknown> = {}) {
  const profile = product.kind === "court-record"
    ? COURT_PROFILE_BY_ID.get(String(product.state.profileId)) : undefined;
  const currentStyleId = String((product.state.cover as Record<string, unknown> | undefined)
    ?.partyStyleId ?? "");
  return workProductResult(product, { draft: product.state,
    ...(profile && { profile: { id: profile.id, label: profile.label,
      cover_fields: profile.cover.fields.map(({ id }) => id),
      ...(profile.cover.partyStyles?.length && {
        party_styles: profile.cover.partyStyles,
        ...(profile.cover.partyStyles.some(({ id }) => id === currentStyleId) &&
          { active_party_style_id: currentStyleId }),
        ...(profile.cover.filingGroupId && { filing_group_id: profile.cover.filingGroupId }),
      }),
      ...(profile.oneOf?.length && { one_of: profile.oneOf }),
      slots: profile.documentKinds.filter((slot) =>
        slot.requirement !== "forbidden" && !slot.generated) } }),
    presets: selectableProfiles.map(({ id, label }) => ({ id, label })), ...values });
}

export function courtRecordSlotTool<Context>(dependencies: Dependencies): BeaverTool<Context> {
  let revision = dependencies.target.revision;
  const payload = (product: CourtRecordProduct, values: Record<string, unknown> = {}) => {
    revision = product.revision;
    return courtRecordResult(product, values);
  };
  return {
    ...schema,
    async execute(input, _context, _signal, call) {
      try {
        let product = await dependencies.workProducts.get(dependencies.scope,
          dependencies.target.id);
        if (product.kind !== "court-record" || product.projectId !== dependencies.projectId) {
          throw new Error("The active Court Record is outside this chat's scope");
        }
        const before = revision;
        if (input.action === "read") {
          const result = payload(product, {
            entry_documents: await entryDocuments(dependencies, product),
            draft_outputs: await draftOutputChoices(dependencies,
              COURT_PROFILE_BY_ID.get(String(product.state.profileId))!),
          });
          return { result: toolText(result), events: [workProductEvent(result, call.id)!] };
        }
        const cover = input.cover === undefined ? undefined
          : isJsonRecord(input.cover) ? input.cover
            : (() => { throw new Error("cover must be an object"); })();
        const documentInput = text(input.document_id);
        const documentRef = dependencies.resolveArtifact?.(documentInput) ?? documentInput;
        const document = documentRef ? parseResourceReference(documentRef) : null;
        const childId = text(input.child_draft_id), role = text(input.output_role);
        const slotId = text(input.slot_id), replaceEntryId = text(input.replace_entry_id);
        const description = text(input.description), date = text(input.date);
        const exhibitLabel = text(input.exhibit_label);
        const values = { ...(description && { description }), ...(date && { date }),
          ...(exhibitLabel && { exhibitLabel }) };
        if (documentRef && document?.kind !== "document") {
          throw new Error("document_id must be a version-pinned Library document");
        }
        if (document?.kind === "document" && (dependencies.projectId
          ? !dependencies.allowedDocumentIds?.has(document.documentId)
          : !await dependencies.library.document({ ...dependencies.scope, kind: "file" },
            document.documentId))) {
          throw new Error("Document is outside this chat's document scope");
        }
        if (document && childId) throw new Error("Bind one source at a time");
        const changesEntry = !!document || !!childId || !!replaceEntryId ||
          !!description || !!date || !!exhibitLabel || !!slotId;
        if (changesEntry && !slotId) throw new Error("An entry change requires slot_id");
        if (!!childId !== !!role) throw new Error("A saved draft source requires output_role");
        const profileId = text(input.profile_id);
        if (!profileId && !cover && !changesEntry) {
          throw new Error("No Court Record changes were supplied");
        }
        if (childId && (profileId || cover)) {
          throw new Error("Update the preset or cover fields before binding a saved output");
        }
        let filled: string[] = [], entryId: string | undefined;
        if (childId) {
          const linked = await dependencies.courtRecords.bindOutput(dependencies.scope, {
            courtRecordId: product.id, revision, kindId: slotId,
            childWorkProductId: childId, role,
            ...(replaceEntryId && { replaceEntryId }), projectId: dependencies.projectId,
            ...values,
          });
          product = linked.product; entryId = linked.entryId;
        } else {
          const updated = await dependencies.courtRecords.updateDraft(dependencies.scope, {
            courtRecordId: product.id, revision, projectId: dependencies.projectId,
            ...(profileId && { profileId }), ...(cover && { cover }),
            ...(changesEntry && { entry: { slotId,
              ...(replaceEntryId && { replaceEntryId }), ...values,
              ...(document?.kind === "document" && { document: {
                documentId: document.documentId, versionId: document.versionId,
              } }),
            } }),
          });
          product = updated.product; filled = updated.filled; entryId = updated.entryId;
        }
        const result = payload(product, { filled_fields: filled, entry_id: entryId });
        const mutated = product.revision !== before;
        if (mutated) dependencies.onMutationCommitted();
        return { result: toolText(result), mutated,
          events: [workProductEvent(result, call.id)!] };
      } catch (error) {
        const result = { ok: false, error: safeErrorMessage(error,
          "The Court Record could not be updated") };
        return { result: toolText(result, true), events: [workProductEvent(result, call.id)!] };
      }
    },
  };
}

const MAX_TURN_PAGE_IMAGES = 6;

const pageSchema: Tool & BeaverToolPolicy = {
  name: "view_page",
  activity: (input) => `Looking at page ${Number(input.page) || 1}`,
  description: "Look at one page of a Library PDF, or an image file, as a picture. Use it whenever " +
    "a page is scanned, handwritten, stamped, a diagram, or extracted poorly: read names, dates, " +
    "numbers and stamps off the image rather than guessing a value that extraction left empty or " +
    "garbled. Name a Library document with document_id from Read, or an entry of the open Court " +
    "Record with entry_id. Up to 6 pages a turn.",
  annotations: { readOnlyHint: true },
  inputSchema: objectSchema({
    entry_id: { type: "string", minLength: 1, maxLength: 200,
      description: "Entry of the active Court Record, from its read result." },
    document_id: { type: "string", maxLength: 300,
      description: "Version-pinned Library document returned by Read." },
    version_id: { type: "string", maxLength: 200 },
    page: { type: "integer", minimum: 1, maximum: 5_000 },
  }, ["page"]),
};

type PageDependencies = Pick<Dependencies, "scope" | "projectId" |
  "allowedDocumentIds" | "library" | "workProducts" | "resolveArtifact"> &
  { target?: Dependencies["target"]; documents: Pick<DocumentStore, "read"> };

export function courtRecordPageTool<Context>(
  dependencies: PageDependencies,
): BeaverTool<Context> {
  let shown = 0;
  return {
    ...pageSchema,
    async execute(input, _context, signal) {
      try {
        if (shown >= MAX_TURN_PAGE_IMAGES) {
          throw new Error(`Only ${MAX_TURN_PAGE_IMAGES} pages can be viewed in one turn`);
        }
        const entryId = text(input.entry_id), page = Number(input.page);
        const raw = text(input.document_id);
        const reference = raw ? parseResourceReference(
          dependencies.resolveArtifact?.(raw) ?? raw) : null;
        let documentId = reference?.kind === "document" ? reference.documentId : raw;
        let versionId: string | null = reference?.kind === "document"
          ? reference.versionId : text(input.version_id) || null;
        if (entryId) {
          if (!dependencies.target) throw new Error("entry_id needs an open Court Record");
          const product = await dependencies.workProducts.get(dependencies.scope,
            dependencies.target.id);
          const bindings = isJsonRecord(product.state.bindings) ? product.state.bindings : {};
          const binding = isJsonRecord(bindings[entryId]) ? bindings[entryId] : null;
          if (binding?.kind !== "document") {
            throw new Error(`Entry ${entryId} has no Library document to look at`);
          }
          documentId = String(binding.documentId);
          versionId = isJsonRecord(binding.version) ? String(binding.version.versionId) : null;
        } else if (!documentId) {
          throw new Error("entry_id or document_id is required");
        } else if (dependencies.projectId
          ? !dependencies.allowedDocumentIds?.has(documentId)
          : !await dependencies.library.document({ ...dependencies.scope, kind: "file" },
            documentId)) {
          throw new Error("Document is outside this chat's document scope");
        }
        const file = await dependencies.documents.read(dependencies.scope, documentId,
          versionId, true);
        if (!file) throw new Error("The document could not be read");
        if (isImageDocumentType(file.fileType)) {
          shown += 1;
          return { result: toolText({ ok: true, filename: file.filename, page: 1, page_count: 1 }),
            metadata: { images: [toLlmImage(file.filename, file.bytes, file.fileType)] } };
        }
        if (file.fileType.toLowerCase() !== "pdf" && !file.hasPdfRendition) {
          throw new Error(`Only PDF pages and images can be viewed; this file is ${file.fileType}. Use Read.`);
        }
        const rendered = await renderPdfPage(file.bytes, page, file.filename, signal);
        shown += 1;
        return {
          result: toolText({ ok: true, filename: file.filename, page: rendered.page,
            page_count: rendered.pageCount, width: rendered.width, height: rendered.height }),
          metadata: { images: [rendered.image] },
        };
      } catch (error) {
        return { result: toolText({ ok: false,
          error: safeErrorMessage(error, "The page could not be shown") }, true) };
      }
    },
  };
}
