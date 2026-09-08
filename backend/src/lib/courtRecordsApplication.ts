import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import { docxToPdf } from "./convert";
import { contentTypeForDocumentType, validateDocumentFile } from "./documentTypes";
import { COURT_PROFILE_BY_ID, type PartyStyle, type CourtProfile }
  from "mike/shared/court-record-profiles.mjs";
import { decodeCourtRecordDraftState, decodeCourtRecordPartyContact,
  type CourtRecordPartyContact } from "./courtRecordContract";
import { documentProjectionService } from "./documentProjectionService";
import type { DocumentFile, DocumentStore } from "./documentStore";
import { decodeWorkProductBuildReceipt, type WorkProductInput } from "./workProduct";
import { saveWorkProductBuild, type WorkProductApplication } from "./workProductApplication";
import type { WorkflowFiles } from "./workflowFiles";
import { canonicalJson, canonicalJsonSha256, sha256 } from "./hash";
import { sourceExhibitLabels } from "mike/shared/court-record-exhibits.mjs";
import { sourceDocumentFields } from "mike/shared/court-record-source-fields.mjs";
import { acceptsWorkProductOutput } from "mike/shared/court-record-work-products.mjs";

type ProjectionReader = Pick<typeof documentProjectionService, "lookupPdf" | "preparePdf">;
export const MAX_COURT_BUILD_OUTPUTS = 500;

type PartyGroup = { id: string; role: string; roleBelow?: string;
  parties: Array<{ id: string; name: string; contact?: CourtRecordPartyContact }> };
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
      return saveWorkProductBuild({ documents, files, workProducts }, scope, product,
        artifacts.map(({ file }, index) => ({ role: receipts[index]!.output.role,
          file, receipt: receipts[index]! })));
    },
    async bindOutput(scope: ApplicationScope, input: {
      courtRecordId: string; revision: number; kindId: string;
      childWorkProductId: string; role: string; replaceEntryId?: string;
      description?: string; date?: string; exhibitLabel?: string;
      projectId?: string | null;
    }) {
      const [record, child] = await Promise.all([
        workProducts.get(scope, input.courtRecordId),
        workProducts.get(scope, input.childWorkProductId),
      ]);
      if (record.kind !== "court-record" || child.projectId !== record.projectId) {
        throw new ApplicationError(409, "Select a Court Record and a saved draft output");
      }
      if (Object.hasOwn(input, "projectId") && record.projectId !== input.projectId) {
        throw new ApplicationError(404, "Court record not found in this matter");
      }
      if (record.revision !== input.revision) {
        throw new ApplicationError(409, "This court record changed. Reload it before editing");
      }
      const state = record.state as { entries?: unknown; bindings?: unknown };
      if (!Array.isArray(state.entries) || !state.bindings ||
          typeof state.bindings !== "object" || Array.isArray(state.bindings)) {
        throw new ApplicationError(409, "This court record draft is invalid");
      }
      const profile = COURT_PROFILE_BY_ID.get(String(record.state.profileId));
      const slot = profile?.documentKinds.find(({ id }) => id === input.kindId);
      if (!slot || slot.requirement === "forbidden" || slot.generated || slot.descriptionOnly ||
          !acceptsWorkProductOutput(slot, { kind: child.kind,
            profileId: child.kind === "court-record" ? String(child.state.profileId) : undefined,
            role: input.role })) {
        throw new ApplicationError(409, "Select a saved output accepted by this Court Record slot");
      }
      const output = child.outputs[input.role];
      const fileType = output && (["pdf", "docx"] as const).find((type) =>
        output.mimeType === contentTypeForDocumentType(type));
      const version = output && (await documents.versions(scope, output.documentId))
        ?.versions.find(({ id }) => id === output.versionId);
      if (!output || !fileType || !(slot.acceptedFormats ?? ["pdf", "docx"]).includes(fileType) ||
          !version || version.source_sha256 !== output.sha256 || version.file_type !== fileType) {
        throw new ApplicationError(409, `The ${input.role} output is unavailable`);
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
      const profile = COURT_PROFILE_BY_ID.get(profileId);
      if (!profile) {
        throw new ApplicationError(400, "Select an available court record format");
      }
      if (profileId !== state.profileId && state.entries.length) {
        throw new ApplicationError(409,
          "Remove or move the existing documents before changing the court record format");
      }
      const cover = structuredClone(state.cover);
      const partyStyles = profile.cover.partyStyles ?? [];
      if (profileId !== state.profileId) cleanCoverForProfile(cover, profile);
      const requestedStyleId = typeof input.cover?.partyStyleId === "string"
        ? input.cover.partyStyleId.trim() : "";
      if (requestedStyleId && !partyStyles.some(({ id }) => id === requestedStyleId)) {
        throw new ApplicationError(400, "Invalid cover field: partyStyleId");
      }
      const currentStyleId = typeof cover.partyStyleId === "string"
        ? cover.partyStyleId.trim() : "";
      const partyStyle = partyStyles.find(({ id }) => id === currentStyleId) ??
        partyStyles.find(({ id }) => id === requestedStyleId) ??
        (partyStyles.length === 1 ? partyStyles[0] : undefined);
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
        if (field === "filingPartyIds") {
          // validCover authoritatively checks ids, uniqueness, limits and filing-group
          // membership; only emptiness has to be refused before the value is stored.
          if (!Array.isArray(value) || !value.length) {
            throw new ApplicationError(400, "Invalid cover field: filingPartyIds");
          }
          if (!Array.isArray(cover.filingPartyIds) || !cover.filingPartyIds.length) {
            cover.filingPartyIds = value;
            filled.push(field);
          }
          continue;
        }
        if (![...profile.cover.fields.map(({ id }) => id), "partyStyleId"].includes(field) ||
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
        const slot = profile.documentKinds.find(({ id }) => id === patch.slotId);
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
        if (values.exhibitLabel) await assertExhibitAssignment(documents, scope, entries,
          bindings, values.exhibitLabel, patch.replaceEntryId);
        if (note) {
          if (patch.document || !values.description && !patch.replaceEntryId) {
            throw new ApplicationError(409, "This slot requires a description, not a file");
          }
          entryId = upsertEntry(entries, slot.id, patch.replaceEntryId, !!slot.repeatable,
            slot.label, { name: "description-only", size: 0, modified: 0 }, values, true);
        } else if (patch.document) {
          const version = await documents.metadata(scope, patch.document.documentId);
          const format = version?.file_type.toLowerCase();
          if (!version || version.current_version_id !== patch.document.versionId ||
              (format !== "pdf" && format !== "docx") ||
              !(slot.acceptedFormats ?? ["pdf", "docx"]).includes(format)) {
            throw new ApplicationError(409, "The selected Library version cannot fill this slot");
          }
          const lastSeen = { name: version.filename, size: version.size_bytes,
            modified: Date.parse(version.updated_at) || 0,
            sha256: version.source_sha256 };
          entryId = upsertEntry(entries, slot.id, patch.replaceEntryId, !!slot.repeatable,
            slot.repeatable ? withoutExtension(version.filename) : slot.label,
            lastSeen, values);
          bindings[entryId] = { kind: "document", documentId: patch.document.documentId,
            version: "latest" };
          const attached = entries.find(({ id }) => id === entryId)!;
          delete attached.sourceFields;
          const prepared = format === "pdf"
            ? await readPreparedPageText(documents, projection, scope,
              patch.document.documentId, patch.document.versionId, version).catch(() => null)
            : null;
          if (prepared) attached.sourceFields = sourceDocumentFields(
            prepared.pages.map(({ text }) => text));
          if (slot.id === "affidavit") {
            const affidavit = attached;
            delete affidavit.sourceExhibits;
            for (const entry of entries) if (entry.kindId === "exhibit") {
              delete entry.exhibitLabel;
            }
            const labels = prepared
              ? sourceExhibitLabels(prepared.pages.map(({ text }) => text)) : [];
            if (prepared && labels.length) affidavit.sourceExhibits = {
              sourceSha256: prepared.source_sha256, labels,
            };
          }
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
        const text = await pageText(projection, () => bytes, prepared.pageCount, {
          persistEvidence: false, documentId, versionId, sourceSha256: digest,
          pdfProfile: { cacheKey: prepared.cacheKey, profile: prepared.profile,
            status: prepared.status },
        });
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
      return readPreparedPageText(documents, projection, scope, documentId, versionId);
    },
    async pdfRendition(file: DocumentFile) {
      if (file.fileType !== "docx") {
        throw new ApplicationError(400, "A Word (.docx) file is required");
      }
      return convert("bytes" in file ? file.bytes : await readFile(file.path));
    },
  });
}

/**
 * Page text for a whole PDF. Exact page ranges are bounded by the projection, so a
 * record-sized document is read in successive spans. A span of scanned pages carries
 * no text at all; that is the answer for those pages, not a failure of the read.
 */
async function pageText(projection: ProjectionReader, readBytes: () => Buffer | Promise<Buffer>,
  pageCount: number, options: Omit<Parameters<ProjectionReader["lookupPdf"]>[2], "pages">) {
  const text = new Map<number, string>();
  async function read(first: number, last: number) {
    const lookup = await projection.lookupPdf(readBytes, { locatorKind: "page",
      locator: first === last ? `${first}` : `${first}-${last}`, contextBlocks: 0 }, options);
    if (lookup.status === "found") {
      for (const page of lookup.pages) text.set(page.page_number, page.text);
    } else if (lookup.status === "unavailable" &&
        lookup.error === "The requested structural unit has no exact text") {
      // One blank page makes the entire range unavailable; retain its readable neighbours.
      if (first !== last) for (let page = first; page <= last; page++) await read(page, page);
    } else {
      throw new ApplicationError(409, "The prepared PDF page text is unavailable");
    }
  }
  for (let first = 1; first <= pageCount; first += 20) {
    await read(first, Math.min(first + 19, pageCount));
  }
  return text;
}

async function readPreparedPageText(documents: DocumentStore, projection: ProjectionReader,
  scope: ApplicationScope, documentId: string, versionId: string | null,
  knownMetadata?: Awaited<ReturnType<DocumentStore["metadata"]>>) {
  const [metadata, source] = await Promise.all([
    knownMetadata ?? documents.metadata(scope, documentId),
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
  const text = await pageText(projection, source.readBytes, pageCount, {
    persistEvidence: false, documentId, versionId: source.versionId,
    sourceSha256: source.sourceSha256, pdfProfile: source.pdfProfile,
  });
  return { document_id: documentId, version_id: source.versionId,
    source_sha256: source.sourceSha256, page_count: pageCount,
    parser_status: source.pdfProfile?.status ?? "ready",
    pages: Array.from({ length: pageCount }, (_, index) => ({
      page_number: index + 1, text: text.get(index + 1) ?? "",
    })) };
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
    values[field] = field === "exhibitLabel" ? value.trim().toUpperCase() : value.trim();
  }
  return values;
}

async function assertExhibitAssignment(documents: DocumentStore, scope: ApplicationScope,
  entries: Array<Record<string, unknown>>, bindings: Record<string, WorkProductInput>,
  label: string, replaceId?: string) {
  const affidavit = entries.find(({ kindId }) => kindId === "affidavit");
  const source = object(affidavit?.sourceExhibits) ? affidavit.sourceExhibits : null;
  if (!source || !Array.isArray(source.labels) || !source.labels.includes(label) ||
      entries.some((entry) => entry.kindId === "exhibit" && entry.id !== replaceId &&
        entry.exhibitLabel === label)) {
    throw new ApplicationError(409, "Choose an unfilled exhibit slot from the source affidavit");
  }
  const binding = bindings[String(affidavit?.id ?? "")];
  if (binding?.kind !== "document") return;
  const version = await documents.projectionSource(scope, binding.documentId,
    binding.version === "latest" ? null : binding.version.versionId);
  if (!version || version.sourceSha256 !== source.sourceSha256 ||
      binding.version !== "latest" && binding.version.sha256 !== source.sourceSha256) {
    throw new ApplicationError(409,
      "The source affidavit changed. Reload it before assigning exhibits");
  }
}

function selectedOcrPages(value: unknown) {
  if (!Array.isArray(value) || !value.length || value.length > 2_000 ||
      !value.every((page) => typeof page === "number" && Number.isSafeInteger(page) &&
        page > 0 && page <= 2_000)) {
    throw new ApplicationError(400, "OCR pages must be one-based page numbers");
  }
  return [...new Set(value as number[])].sort((left, right) => left - right);
}

function parsePartyGroups(value: unknown, profile: CourtProfile,
  style: PartyStyle, requireNames = false): PartyGroup[] {
  const definitions = new Map(style.groups.map((group) => [group.id, group]));
  const partyGroups = !Array.isArray(value) ? value : value.map((raw) => {
    const group = object(raw) ? raw : {};
    const definition = definitions.get(String(group.id));
    return {
      ...(definition && { id: definition.id, role: definition.role,
        ...(definition.roleBelow && { roleBelow: definition.roleBelow }) }),
      parties: !Array.isArray(group.parties) ? group.parties : group.parties.map((rawParty) => {
        const party = object(rawParty) ? rawParty : {};
        const contact = decodeCourtRecordPartyContact(party.contact);
        return { id: party.id,
          name: typeof party.name === "string" ? party.name.trim() : party.name,
          ...(party.contact !== undefined && { contact: contact
            ? Object.fromEntries(Object.entries(contact).map(([key, field]) => [key, field.trim()]))
            : party.contact }) };
      }),
    };
  });
  if (!decodeCourtRecordDraftState({ profileId: profile.id,
    cover: { partyStyleId: style.id, partyGroups }, entries: [], bindings: {} })) {
    throw new ApplicationError(400, "Invalid cover field: partyGroups");
  }
  const groups = partyGroups as PartyGroup[];
  if (requireNames && groups.some(({ parties }) => parties.some(({ name }) => !name))) {
    throw new ApplicationError(400, "Party names and roles are required");
  }
  return groups;
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
      else {
        const currentParty = parties[partyIndex];
        parties[partyIndex] = { ...currentParty,
          ...(!currentParty.name.trim() && { name: party.name }),
          ...(party.contact && { contact: { ...party.contact, ...Object.fromEntries(
            Object.entries(currentParty.contact ?? {}).filter(([, value]) => value.trim()),
          ) } }) };
      }
    }
    groups[index] = { ...current,
      ...(!current.role.trim() && { role: group.role }),
      ...(!current.roleBelow?.trim() && group.roleBelow && { roleBelow: group.roleBelow }),
      parties };
  }
  return groups;
}

function cleanCoverForProfile(cover: Record<string, unknown>, profile: CourtProfile) {
  const styles = profile.cover.partyStyles ?? [];
  const allowed = new Set([...profile.cover.fields.map(({ id }) => id),
    ...(styles.length ? ["partyStyleId", "partyGroups", "filingPartyIds"] : [])]);
  for (const key of Object.keys(cover)) if (!allowed.has(key)) delete cover[key];
  const style = styles.find(({ id }) => id === cover.partyStyleId);
  if (!style) {
    delete cover.partyStyleId; delete cover.partyGroups; delete cover.filingPartyIds;
    return;
  }
  const groups = parsePartyGroups(cover.partyGroups ?? [], profile, style);
  cover.partyGroups = groups;
  const eligible = new Set(groups.filter((group) => !profile.cover.filingGroupId ||
    group.id === profile.cover.filingGroupId).flatMap((group) => group.parties.map(({ id }) => id)));
  const filingPartyIds = Array.isArray(cover.filingPartyIds)
    ? cover.filingPartyIds.filter((id): id is string => typeof id === "string" && eligible.has(id))
    : [];
  if (filingPartyIds.length) cover.filingPartyIds = filingPartyIds;
  else delete cover.filingPartyIds;
}

export type CourtRecordsApplication = ReturnType<typeof createCourtRecordsApplication>;
