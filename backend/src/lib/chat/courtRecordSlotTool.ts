import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { acceptsWorkProductOutput } from "mike/shared/court-record-work-products.mjs";
import type { ApplicationScope } from "../applicationError";
import { COURT_RECORD_PROFILES, COURT_RECORD_PROFILE_BY_ID,
  COURT_RECORD_PARTY_CONTACT_FIELDS,
  type CourtRecordProfileContract } from "../courtRecordContract";
import type { CourtRecordsApplication } from "../courtRecordsApplication";
import { contentTypeForDocumentType } from "../documentTypes";
import type { LibraryStore } from "../libraryStore";
import { DOCUMENT_OR_DRAFT_PATTERN, parseResourceReference } from "../resourceReferences";
import { safeErrorMessage } from "../safeError";
import { isJsonRecord } from "../value";
import type { WorkProductApplication } from "../workProductApplication";
import { workProductEvent, workProductResult } from "./localWorkflowRun";
import { toolText, type BeaverTool, type BeaverToolPolicy } from "./toolRegistry";

const selectableProfiles = COURT_RECORD_PROFILES.filter((profile) =>
  profile.selectable !== false);
const profileIds = selectableProfiles.map(({ id }) => id);
const coverFields = [...new Set(selectableProfiles.flatMap(({ coverFields: fields }) => fields))];
const partyStyleIds = [...new Set(selectableProfiles.flatMap(({ partyStyles }) =>
  partyStyles?.map(({ id }) => id) ?? []))];
const partyGroupIds = [...new Set(selectableProfiles.flatMap(({ partyStyles }) =>
  partyStyles?.flatMap(({ groups }) => groups.map(({ id }) => id)) ?? []))];
const slotIds = [...new Set(selectableProfiles.flatMap(({ slots }) => slots.flatMap((slot) =>
  slot.requirement === "forbidden" || slot.generated ? [] : [slot.id])))];
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
    "cover fields, parties, slots, entries, and bindings. Update fills empty cover or party fields, " +
  "binds one Library document or compatible saved output, and edits its visible description, date, " +
    "or exhibit label. A description-only slot needs no file.",
  annotations: { readOnlyHint: false },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["read", "update"] },
      ...COURT_RECORD_TOOL_PROPERTIES,
    },
    required: ["action"],
    additionalProperties: false,
  },
};

type Dependencies = {
  scope: ApplicationScope;
  target: { id: string; revision: number };
  projectId: string | null;
  allowedDocumentIds?: Set<string>;
  library: LibraryStore;
  workProducts: Pick<WorkProductApplication, "get" | "list">;
  courtRecords: Pick<CourtRecordsApplication, "bindOutput" | "updateDraft">;
  resolveArtifact?(value: string): string | undefined;
  onMutationCommitted(): void;
};

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const draftOutputChoices = async (dependencies: Dependencies,
  profile: CourtRecordProfileContract) =>
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
      return fileType && profile.slots.some((slot) => acceptsWorkProductOutput(slot, source) &&
        (slot.acceptedFormats ?? ["pdf", "docx"]).includes(fileType)) ? [role] : [];
    }).sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
    return roles.length ? [{ child_draft_id: product.id, title: product.title,
      kind: product.kind, revision: product.revision, output_roles: roles }] : [];
  });

type CourtRecordProduct = Awaited<ReturnType<Dependencies["workProducts"]["get"]>>;
export function courtRecordResult(product: CourtRecordProduct,
  values: Record<string, unknown> = {}) {
  const profile = product.kind === "court-record"
    ? COURT_RECORD_PROFILE_BY_ID.get(String(product.state.profileId)) : undefined;
  const currentStyleId = String((product.state.cover as Record<string, unknown> | undefined)
    ?.partyStyleId ?? "");
  return workProductResult(product, { draft: product.state,
    ...(profile && { profile: { id: profile.id, label: profile.label,
      cover_fields: profile.coverFields,
      ...(profile.partyStyles?.length && {
        party_styles: profile.partyStyles,
        ...(profile.partyStyles.some(({ id }) => id === currentStyleId) &&
          { active_party_style_id: currentStyleId }),
        ...(profile.filingGroupId && { filing_group_id: profile.filingGroupId }),
      }),
      ...(profile.oneOf?.length && { one_of: profile.oneOf }),
      slots: profile.slots.filter((slot) =>
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
            draft_outputs: await draftOutputChoices(dependencies,
              COURT_RECORD_PROFILE_BY_ID.get(String(product.state.profileId))!),
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
