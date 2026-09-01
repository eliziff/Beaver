import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import { docxToPdf } from "./convert";
import { contentTypeForDocumentType, validateDocumentFile } from "./documentTypes";
import { COURT_RECORD_PROFILE_BY_ID, courtRecordProfileIsEffective, decodeCourtRecordDraftState,
  type CourtRecordPartyStyleContract, type CourtRecordProfileContract } from "./courtRecordContract";
import { documentProjectionService } from "./documentProjectionService";
import type { DocumentFile, DocumentStore } from "./documentStore";
import { decodeWorkProductBuildReceipt, type WorkProductInput,
  type WorkProductOutputRef } from "./workProduct";
import type { WorkProductApplication } from "./workProductApplication";
import type { WorkflowFiles } from "./workflowFiles";
import { canonicalJson, canonicalJsonSha256, sha256 } from "./hash";

type ProjectionReader = Pick<typeof documentProjectionService, "lookupPdf" | "preparePdf">;
export const MAX_COURT_BUILD_OUTPUTS = 32;

type PartyGroup = { id: string; role: string; roleBelow?: string;
  parties: Array<{ id: string; name: string }> };
type EntryPatch = { slotId: string; replaceEntryId?: string;
  document?: { documentId: string; versionId: string };
  description?: string; date?: string; exhibitLabel?: string };

export function createCourtRecordsApplication(
  documents: DocumentStore,
  files: WorkflowFiles,
  workProducts: Pick<WorkProductApplication, "get" | "save">,
  projection: ProjectionReader = documentProjectionService,
  convert: (bytes: Buffer) => Promise<Buffer> = docxToPdf,
) {
  return Object.freeze({
    async saveFile(scope: ApplicationScope, file: Parameters<WorkflowFiles["create"]>[2],
      workProductId?: string) {
      if (!workProductId) return files.create(scope, "court-records", file);
      const product = await workProducts.get(scope, workProductId);
      if (product.kind !== "court-record") {
        throw new ApplicationError(404, "Court record not found");
      }
      return files.create(scope, "court-records", file, { projectId: product.projectId });
    },
    async saveBuild(scope: ApplicationScope,
      artifacts: Array<{ file: DocumentFile; receipt: unknown }>) {
      if (!artifacts.length || artifacts.length > MAX_COURT_BUILD_OUTPUTS) {
        throw new ApplicationError(400,
          `A build must contain 1-${MAX_COURT_BUILD_OUTPUTS} outputs`);
      }
      const receipts = artifacts.map(({ receipt }) => decodeWorkProductBuildReceipt(receipt));
      const first = receipts[0];
      const build = first && canonicalJson([
        first.builtAt, first.inputs, first.settings, first.steps,
      ]);
      if (!first || first.workProduct.kind !== "court-record" || receipts.some((receipt) =>
        !receipt || receipt.workProduct.kind !== "court-record" ||
        receipt.workProduct.id !== first.workProduct.id ||
        receipt.workProduct.revision !== first.workProduct.revision ||
        canonicalJson([receipt.builtAt, receipt.inputs, receipt.settings,
          receipt.steps]) !== build)) {
        throw new ApplicationError(400, "Valid receipts for one court record build are required");
      }
      const product = await workProducts.get(scope, first.workProduct.id);
      const roles = new Set<string>();
      const stateSha256 = canonicalJsonSha256(product.state);
      if (product.kind !== "court-record" || product.revision !== first.workProduct.revision ||
          product.state.profileId !== first.settings.profileId ||
          artifacts.some(({ file }, index) => {
            const receipt = receipts[index]!;
            if (roles.has(receipt.output.role)) return true;
            roles.add(receipt.output.role);
            return product.state.profileId !== receipt.settings.profileId ||
              receipt.settings.stateSha256 !== stateSha256 ||
              receipt.output.filename !== file.filename ||
              receipt.output.mimeType !== contentTypeForDocumentType(file.fileType);
          })) {
        throw new ApplicationError(409, "The built files do not match the current court record");
      }
      const refs: Record<string, WorkProductOutputRef> = {};
      const rollback: Array<{ documentId: string; versionId?: string }> = [];
      try {
        for (let index = 0; index < artifacts.length; index += 1) {
          const { file } = artifacts[index], receipt = receipts[index]!;
          const output = { ...file, expectedSha256: receipt.output.sha256,
            provenance: { schemaVersion: 1 as const, actor: "work-product" as const,
              action: "built" as const, receipt } };
          const existing = product.outputs[receipt.output.role];
          const version = existing
            ? await documents.addVersion(scope, existing.documentId, output) : null;
          if (version) {
            rollback.push({ documentId: existing.documentId, versionId: version.id });
            if (version.source_sha256 !== receipt.output.sha256) {
              throw new Error("The saved Court Record output hash does not match its build");
            }
            refs[receipt.output.role] = { documentId: existing.documentId,
              versionId: version.id };
          } else {
            const created = await files.create(scope, "court-records", output,
              { projectId: product.projectId });
            rollback.push({ documentId: created.id });
            if (!created.current_version_id ||
                created.source_sha256 !== receipt.output.sha256) {
              throw new Error("The saved Court Record output hash does not match its build");
            }
            refs[receipt.output.role] = { documentId: created.id,
              versionId: created.current_version_id };
          }
        }
        return await workProducts.save(scope, product.id, {
          revision: product.revision, outputs: refs,
        });
      } catch (error) {
        const failures: unknown[] = [];
        for (const item of rollback.reverse()) {
          try {
            if (item.versionId) await documents.deleteVersion(scope,
              item.documentId, item.versionId);
            else await documents.deleteDocument(scope, item.documentId);
          } catch (cleanup) { failures.push(cleanup); }
        }
        if (failures.length) throw new AggregateError([error, ...failures],
          "Court Record outputs could not be saved or rolled back");
        throw error;
      }
    },
    async bindOutput(scope: ApplicationScope, input: {
      courtRecordId: string; revision: number; kindId: "authorities" | "authority-extract";
      childWorkProductId: string; role: "table" | "book"; replaceEntryId?: string;
      description?: string; date?: string; exhibitLabel?: string;
      projectId?: string | null;
    }) {
      const [record, child] = await Promise.all([
        workProducts.get(scope, input.courtRecordId),
        workProducts.get(scope, input.childWorkProductId),
      ]);
      if (record.kind !== "court-record" || child.kind !== "authorities" ||
          child.projectId !== record.projectId) {
        throw new ApplicationError(409, "Select a Court Record and an Authorities draft");
      }
      if (Object.hasOwn(input, "projectId") && record.projectId !== input.projectId) {
        throw new ApplicationError(404, "Court record not found in this matter");
      }
      if (record.revision !== input.revision) {
        throw new ApplicationError(409, "This court record changed. Reload it before editing");
      }
      const output = child.outputs[input.role];
      const fileType = input.role === "table" ? "docx" : "pdf";
      if (!output || output.mimeType !== contentTypeForDocumentType(fileType)) {
        throw new ApplicationError(409, `The Authorities ${input.role} output is unavailable`);
      }
      const history = await documents.versions(scope, output.documentId);
      const version = history?.versions.find(({ id }) => id === output.versionId);
      if (!version || version.source_sha256 !== output.sha256 ||
          version.file_type !== fileType) {
        throw new ApplicationError(409, `The Authorities ${input.role} output is unavailable`);
      }
      const state = record.state as { entries?: unknown; bindings?: unknown };
      if (!Array.isArray(state.entries) || !state.bindings ||
          typeof state.bindings !== "object" || Array.isArray(state.bindings)) {
        throw new ApplicationError(409, "This court record draft is invalid");
      }
      const profile = COURT_RECORD_PROFILE_BY_ID.get(String(record.state.profileId));
      const slot = profile?.slots.find(({ id }) => id === input.kindId);
      if (!slot || slot.requirement === "forbidden" || slot.generated || slot.descriptionOnly ||
          !(slot.acceptedFormats ?? ["pdf", "docx"]).includes(fileType)) {
        throw new ApplicationError(409, "Select an Authorities output slot available in this format");
      }
      const entries = structuredClone(state.entries) as Array<Record<string, unknown>>;
      const lastSeen = { name: output.filename, size: version.size_bytes,
        modified: Date.parse(version.created_at) || 0, sha256: output.sha256 };
      const values = entryValues(input);
      if (values.exhibitLabel) {
        throw new ApplicationError(400, "Only an exhibit entry has an exhibit label");
      }
      const entryId = upsertEntry(entries, input.kindId, input.replaceEntryId, !!slot.repeatable,
        withoutExtension(output.filename), lastSeen, values);
      const bindings: Record<string, WorkProductInput> = {
        ...state.bindings as Record<string, WorkProductInput>,
        [entryId]: { kind: "work-product-output", workProductId: child.id, role: input.role },
      };
      return { entryId, product: await workProducts.save(scope, record.id, {
        revision: input.revision, state: { ...record.state, entries, bindings },
      }) };
    },
    async updateDraft(scope: ApplicationScope, input: {
      courtRecordId: string; revision: number; projectId?: string | null;
      profileId?: string; cover?: Record<string, unknown>; entry?: EntryPatch;
    }) {
      const record = await workProducts.get(scope, input.courtRecordId);
      if (record.kind !== "court-record" ||
          (Object.hasOwn(input, "projectId") && record.projectId !== input.projectId)) {
        throw new ApplicationError(404, "Court record not found in this matter");
      }
      if (record.revision !== input.revision) {
        throw new ApplicationError(409, "This court record changed. Reload it before editing");
      }
      const state = record.state as { profileId?: unknown; cover?: unknown;
        entries?: unknown; bindings?: unknown };
      if (!Array.isArray(state.entries) || !object(state.cover) || !object(state.bindings)) {
        throw new ApplicationError(409, "This court record draft is invalid");
      }
      const profileId = input.profileId ?? String(state.profileId ?? "");
      const profile = COURT_RECORD_PROFILE_BY_ID.get(profileId);
      if (!profile || !courtRecordProfileIsEffective(profile)) {
        throw new ApplicationError(400, "Select an available court record format");
      }
      if (profileId !== state.profileId && state.entries.length) {
        throw new ApplicationError(409,
          "Remove or move the existing documents before changing the court record format");
      }
      const cover = structuredClone(state.cover);
      const partyStyles = profile.partyStyles ?? [];
      if (profileId !== state.profileId) cleanCoverForProfile(cover, profile);
      const requestedStyleId = typeof input.cover?.partyStyleId === "string"
        ? input.cover.partyStyleId.trim() : "";
      if (requestedStyleId && !partyStyles.some(({ id }) => id === requestedStyleId)) {
        throw new ApplicationError(400, "Invalid cover field: partyStyleId");
      }
      const currentStyleId = typeof cover.partyStyleId === "string"
        ? cover.partyStyleId.trim() : "";
      const partyStyle = partyStyles.find(({ id }) => id === currentStyleId) ??
        partyStyles.find(({ id }) => id === requestedStyleId) ?? partyStyles[0];
      const filled: string[] = [];
      for (const [field, value] of Object.entries(input.cover ?? {})) {
        if (field === "partyGroups") {
          if (!partyStyle) throw new ApplicationError(400, "Invalid cover field: partyGroups");
          const current = parsePartyGroups(cover.partyGroups ?? [], profile, partyStyle);
          const groups = parsePartyGroups(value, profile, partyStyle, true);
          const next = mergePartyGroups(current, groups);
          if (canonicalJson(next) !== canonicalJson(cover.partyGroups ?? [])) {
            cover.partyGroups = next;
            filled.push(field);
          }
          continue;
        }
        if (![...profile.coverFields, "partyStyleId", "filingPartyId"].includes(field) ||
            typeof value !== "string" || !value.trim() || value.length > 5_000) {
          throw new ApplicationError(400, `Invalid cover field: ${field}`);
        }
        if (typeof cover[field] !== "string" || !String(cover[field]).trim()) {
          cover[field] = value.trim();
          filled.push(field);
        }
      }
      const entries = structuredClone(state.entries) as Array<Record<string, unknown>>;
      const bindings = structuredClone(state.bindings) as Record<string, WorkProductInput>;
      let entryId: string | undefined;
      if (input.entry) {
        const patch = input.entry;
        const slot = profile.slots.find(({ id }) => id === patch.slotId);
        if (!slot || slot.requirement === "forbidden" || slot.generated) {
          throw new ApplicationError(409, "Select a slot available in this format");
        }
        const existing = patch.replaceEntryId
          ? entries.find(({ id }) => id === patch.replaceEntryId) : undefined;
        const note = slot.descriptionOnly || existing?.descriptionOnly === true ||
          !!slot.allowUnavailableNote && !patch.document && !patch.replaceEntryId;
        const values = entryValues({ ...patch,
          ...(!patch.description && note ? { description: slot.defaultDescription ??
            `${slot.label.replace(/^Part [12]\s+—\s+/u, "")} was not available when this appeal record was prepared.` } : {}) });
        if (values.exhibitLabel && slot.id !== "exhibit") {
          throw new ApplicationError(400, "Only an exhibit entry has an exhibit label");
        }
        if (note) {
          if (patch.document || !values.description && !patch.replaceEntryId) {
            throw new ApplicationError(409, "This slot requires a description, not a file");
          }
          entryId = upsertEntry(entries, slot.id, patch.replaceEntryId, !!slot.repeatable,
            slot.label, { name: "description-only", size: 0, modified: 0 }, values, true);
        } else if (patch.document) {
          const history = await documents.versions(scope, patch.document.documentId);
          const version = history?.versions.find(({ id }) => id === patch.document!.versionId);
          const format = version?.file_type.toLowerCase();
          if (!version || history?.current_version_id !== version.id ||
              (format !== "pdf" && format !== "docx") ||
              !(slot.acceptedFormats ?? ["pdf", "docx"]).includes(format)) {
            throw new ApplicationError(409, "The selected Library version cannot fill this slot");
          }
          const lastSeen = { name: version.filename, size: version.size_bytes,
            modified: Date.parse(version.created_at) || 0, sha256: version.source_sha256 };
          entryId = upsertEntry(entries, slot.id, patch.replaceEntryId, !!slot.repeatable,
            slot.repeatable ? withoutExtension(version.filename) : slot.label,
            lastSeen, values);
          bindings[entryId] = { kind: "document", documentId: patch.document.documentId,
            version: "latest" };
        } else {
          if (!patch.replaceEntryId || !Object.keys(values).length) {
            throw new ApplicationError(409, "Select an existing entry or add a file");
          }
          entryId = upsertEntry(entries, slot.id, patch.replaceEntryId,
            !!slot.repeatable, slot.label, undefined, values);
        }
      }
      const changed = profileId !== state.profileId || filled.length > 0 || !!entryId;
      if (!changed) return { product: record, filled, entryId };
      const nextState = { ...record.state, profileId, cover, entries, bindings };
      if (!decodeCourtRecordDraftState(nextState)) {
        throw new ApplicationError(400, "The Court Record fields are invalid");
      }
      return { filled, entryId, product: await workProducts.save(scope, record.id, {
        revision: input.revision, state: nextState,
      }) };
    },
    async prepareUploadedPdf(file: DocumentFile, requestedPages: unknown) {
      const pages = selectedOcrPages(requestedPages);
      const bytes = "bytes" in file ? file.bytes : await readFile(file.path);
      if ("sizeBytes" in file && bytes.byteLength !== file.sizeBytes) {
        throw new Error("Uploaded file size changed while reading");
      }
      const validated = validateDocumentFile(file.filename, bytes);
      if (!validated.ok || validated.fileType !== "pdf" || file.fileType !== "pdf") {
        throw new ApplicationError(400,
          validated.ok ? "A PDF is required" : validated.error);
      }
      const digest = sha256(bytes), documentId = `court-record:${digest}`,
        versionId = `source:${digest}`;
      try {
        const prepared = await projection.preparePdf({ documentId, versionId, bytes,
          sourceSha256: digest, pages, ocrProvider: "kraken-lite" });
        if (!Number.isSafeInteger(prepared.pageCount) || prepared.pageCount < 1 ||
            prepared.pageCount > 2_000) {
          throw new ApplicationError(409, "This PDF has an unsupported page count");
        }
        const lookup = await projection.lookupPdf(() => bytes, {
          locatorKind: "page",
          locator: prepared.pageCount === 1 ? "1" : `1-${prepared.pageCount}`,
          contextBlocks: 0,
        }, {
          persistEvidence: false, documentId, versionId, sourceSha256: digest,
          pdfProfile: { cacheKey: prepared.cacheKey, profile: prepared.profile,
            status: prepared.status },
        });
        if (lookup.status !== "found") {
          throw new ApplicationError(409, "The prepared PDF page text is unavailable");
        }
        const text = new Map(lookup.pages.map((page) => [page.page_number, page.text]));
        return { source_sha256: digest, page_count: prepared.pageCount,
          parser_status: prepared.status,
          ocr_pages: prepared.ocrRoutedPages.map((page) => page + 1),
          pages: Array.from({ length: prepared.pageCount }, (_, index) => ({
            page_number: index + 1, text: text.get(index + 1) ?? "",
          })) };
      } catch (error) {
        if (error instanceof ApplicationError) throw error;
        if (error instanceof Error && error.name === "PdfEncrypted") {
          throw new ApplicationError(409, error.message);
        }
        if (error instanceof Error && ["PDF is invalid or corrupt",
          "PDF structural parser failed"].includes(error.message)) {
          throw new ApplicationError(400, error.message);
        }
        throw error;
      }
    },
    async preparedPageText(
      scope: ApplicationScope,
      documentId: string,
      versionId: string | null,
    ) {
      const [metadata, source] = await Promise.all([
        documents.metadata(scope, documentId),
        documents.projectionSource(scope, documentId, versionId),
      ]);
      if (!metadata || !source) throw new ApplicationError(404, "Document not found");
      if (source.fileType.toLowerCase() !== "pdf") {
        throw new ApplicationError(409, "Court record sources must be PDFs");
      }
      const pageCount = source.versionId === metadata.current_version_id
        ? Number(metadata.page_count ?? metadata.parse_state?.page_count)
        : Number((await documents.read(scope, documentId, source.versionId, false))
          ?.version.page_count);
      if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 2_000) {
        throw new ApplicationError(409, "Prepare this PDF before using it in a court record");
      }
      const lookup = await projection.lookupPdf(source.readBytes, {
        locatorKind: "page",
        locator: pageCount === 1 ? "1" : `1-${pageCount}`,
        contextBlocks: 0,
      }, {
        persistEvidence: false,
        documentId,
        versionId: source.versionId,
        sourceSha256: source.sourceSha256,
        pdfProfile: source.pdfProfile,
      });
      if (lookup.status !== "found") {
        throw new ApplicationError(409, "The prepared PDF page text is unavailable");
      }
      const text = new Map(lookup.pages.map((page) => [page.page_number, page.text]));
      return {
        document_id: documentId,
        version_id: source.versionId,
        source_sha256: source.sourceSha256,
        page_count: pageCount,
        parser_status: source.pdfProfile?.status ?? "ready",
        pages: Array.from({ length: pageCount }, (_, index) => ({
          page_number: index + 1,
          text: text.get(index + 1) ?? "",
        })),
      };
    },
    async pdfRendition(file: DocumentFile) {
      if (file.fileType !== "docx") {
        throw new ApplicationError(400, "A Word (.docx) file is required");
      }
      return convert("bytes" in file ? file.bytes : await readFile(file.path));
    },
  });
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const withoutExtension = (filename: string) => filename.replace(/\.(?:pdf|docx)$/iu, "");
function upsertEntry(entries: Array<Record<string, unknown>>, kindId: string,
  replaceId: string | undefined, repeatable: boolean, title: string,
  lastSeen: Record<string, unknown> | undefined,
  values: { description?: string; date?: string; exhibitLabel?: string } = {},
  descriptionOnly = false) {
  const index = replaceId ? entries.findIndex(({ id }) => id === replaceId) : -1;
  if ((replaceId && (index < 0 || entries[index].kindId !== kindId)) ||
      (!replaceId && (!lastSeen || !repeatable && entries.some((entry) => entry.kindId === kindId)))) {
    throw new ApplicationError(409, "Select the exact existing slot entry to replace");
  }
  const id = replaceId ?? randomUUID();
  const current = index < 0 ? { id, kindId, title, lastSeen } : entries[index];
  entries[index < 0 ? entries.length : index] = {
    ...current, ...(lastSeen && { lastSeen }),
    ...(values.description && (index < 0 || !String(current.title ?? "").trim()) &&
      { title: values.description }),
    ...(values.date && (index < 0 || !String(current.date ?? "").trim()) &&
      { date: values.date }),
    ...(values.exhibitLabel && (index < 0 || !String(current.exhibitLabel ?? "").trim()) &&
      { exhibitLabel: values.exhibitLabel }),
    ...(descriptionOnly && { descriptionOnly: true }),
  };
  return id;
}

function entryValues(input: { description?: string; date?: string; exhibitLabel?: string }) {
  const values: { description?: string; date?: string; exhibitLabel?: string } = {};
  for (const [field, max] of [["description", 1_000], ["date", 500],
    ["exhibitLabel", 500]] as const) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > max) {
      throw new ApplicationError(400, `Invalid entry field: ${field}`);
    }
    values[field] = value.trim();
  }
  return values;
}

function selectedOcrPages(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 2_000 ||
      !value.every((page) => typeof page === "number" && Number.isSafeInteger(page) &&
        page > 0 && page <= 2_000)) {
    throw new ApplicationError(400, "OCR pages must be one-based page numbers");
  }
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

function parsePartyGroups(value: unknown, profile: CourtRecordProfileContract,
  style: CourtRecordPartyStyleContract, requireNames = false): PartyGroup[] {
  const definitions = new Map(style.groups.map((group) => [group.id, group]));
  if (!Array.isArray(value)) {
    throw new ApplicationError(400, "Invalid cover field: partyGroups");
  }
  const groups = value.map((raw) => {
    const group = object(raw) ? raw : null;
    const definition = definitions.get(String(group?.id));
    const parties = Array.isArray(group?.parties) ? group.parties.map((rawParty) => {
      const party = object(rawParty) ? rawParty : null;
      if (typeof party?.id !== "string" || typeof party.name !== "string") {
        throw new ApplicationError(400, "Invalid cover field: partyGroups");
      }
      return { id: party.id, name: party.name };
    }) : null;
    if (!group || !definition || !parties) {
      throw new ApplicationError(400, "Invalid cover field: partyGroups");
    }
    return { id: definition.id, role: definition.role,
      ...(definition.roleBelow && { roleBelow: definition.roleBelow }), parties };
  });
  const state = { profileId: profile.id,
    cover: { partyStyleId: style.id, partyGroups: groups }, entries: [], bindings: {} };
  if (!decodeCourtRecordDraftState(state)) {
    throw new ApplicationError(400, "Invalid cover field: partyGroups");
  }
  if (requireNames && groups.some((group) => group.parties.some((party) =>
    !party.name.trim()))) {
    throw new ApplicationError(400, "Party names and roles are required");
  }
  return groups.map((group) => ({ ...group, role: group.role.trim(),
    ...(group.roleBelow ? { roleBelow: group.roleBelow.trim() } : {}),
    parties: group.parties.map((party) => ({ id: String(party.id),
      name: String(party.name).trim() })) }));
}

function mergePartyGroups(value: unknown, incoming: PartyGroup[]): PartyGroup[] {
  const groups = Array.isArray(value) ? structuredClone(value) as PartyGroup[] : [];
  for (const group of incoming) {
    const index = groups.findIndex(({ id }) => id === group.id);
    if (index < 0) { groups.push(group); continue; }
    const current = groups[index], parties = [...current.parties];
    for (const party of group.parties) {
      const partyIndex = parties.findIndex(({ id }) => id === party.id);
      if (partyIndex < 0) parties.push(party);
      else if (!parties[partyIndex].name.trim()) parties[partyIndex] = party;
    }
    groups[index] = { ...current,
      ...(!current.role.trim() && { role: group.role }),
      ...(!current.roleBelow?.trim() && group.roleBelow && { roleBelow: group.roleBelow }),
      parties };
  }
  return groups;
}

function cleanCoverForProfile(cover: Record<string, unknown>, profile: CourtRecordProfileContract) {
  const styles = profile.partyStyles ?? [];
  const allowed = new Set([...profile.coverFields,
    ...(styles.length ? ["partyStyleId", "partyGroups", "filingPartyId"] : [])]);
  for (const key of Object.keys(cover)) if (!allowed.has(key)) delete cover[key];
  const style = styles.find(({ id }) => id === cover.partyStyleId);
  if (!style) {
    delete cover.partyStyleId; delete cover.partyGroups; delete cover.filingPartyId;
    return;
  }
  const groups = parsePartyGroups(cover.partyGroups ?? [], profile, style);
  cover.partyGroups = groups;
  const filingId = String(cover.filingPartyId ?? "");
  const filingGroup = groups.find(({ parties }) => parties.some(({ id }) => id === filingId));
  if (!filingGroup || profile.filingGroupId && filingGroup.id !== profile.filingGroupId) {
    delete cover.filingPartyId;
  }
}

export type CourtRecordsApplication = ReturnType<typeof createCourtRecordsApplication>;
