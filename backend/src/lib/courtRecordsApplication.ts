import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ApplicationError, type ApplicationScope } from "./applicationError";
import { docxToPdf } from "./convert";
import { contentTypeForDocumentType } from "./documentTypes";
import { COURT_RECORD_PROFILE_BY_ID } from "./courtRecordContract";
import { documentProjectionService } from "./documentProjectionService";
import type { DocumentFile, DocumentStore } from "./documentStore";
import { decodeWorkProductBuildReceipt, type WorkProductInput,
  type WorkProductOutputRef } from "./workProduct";
import type { WorkProductApplication } from "./workProductApplication";
import type { WorkflowFiles } from "./workflowFiles";
import { canonicalJson, canonicalJsonSha256 } from "./hash";

type ProjectionReader = Pick<typeof documentProjectionService, "lookupPdf">;
export const MAX_COURT_BUILD_OUTPUTS = 32;

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
      projectId?: string | null;
    }) {
      const [record, child] = await Promise.all([
        workProducts.get(scope, input.courtRecordId),
        workProducts.get(scope, input.childWorkProductId),
      ]);
      if (record.kind !== "court-record" || child.kind !== "authorities") {
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
      const entries = structuredClone(state.entries) as Array<Record<string, unknown>>;
      const index = input.replaceEntryId
        ? entries.findIndex(({ id }) => id === input.replaceEntryId) : -1;
      if ((input.replaceEntryId && (index < 0 || entries[index].kindId !== input.kindId)) ||
          (!input.replaceEntryId && entries.some(({ kindId }) => kindId === input.kindId))) {
        throw new ApplicationError(409, "Select the exact existing slot entry to replace");
      }
      const entryId = input.replaceEntryId ?? randomUUID();
      const lastSeen = { name: output.filename, size: version.size_bytes,
        modified: Date.parse(version.created_at) || 0, sha256: output.sha256 };
      const entry = index < 0 ? { id: entryId, kindId: input.kindId,
        title: output.filename.replace(/\.(?:pdf|docx)$/iu, ""), lastSeen }
        : { ...entries[index], lastSeen };
      if (index < 0) entries.push(entry); else entries[index] = entry;
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
      profileId?: string; cover?: Record<string, string>;
      document?: { documentId: string; versionId: string; slotId: string;
        replaceEntryId?: string };
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
      if (!profile) throw new ApplicationError(400, "Select an available court record format");
      if (profileId !== state.profileId && state.entries.length) {
        throw new ApplicationError(409,
          "Remove or move the existing documents before changing the court record format");
      }
      const cover = structuredClone(state.cover);
      const filled: string[] = [];
      for (const [field, value] of Object.entries(input.cover ?? {})) {
        if (!profile.coverFields.includes(field) || typeof value !== "string" ||
            !value.trim() || value.length > 5_000) {
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
      if (input.document) {
        const slot = profile.slots.find(({ id }) => id === input.document!.slotId);
        if (!slot || slot.requirement === "forbidden" || slot.generated ||
            slot.descriptionOnly) {
          throw new ApplicationError(409, "Select a file slot available in this format");
        }
        const history = await documents.versions(scope, input.document.documentId);
        const version = history?.versions.find(({ id }) => id === input.document!.versionId);
        const format = version?.file_type.toLowerCase();
        if (!version || history?.current_version_id !== version.id ||
            (format !== "pdf" && format !== "docx") ||
            !(slot.acceptedFormats ?? ["pdf", "docx"]).includes(format)) {
          throw new ApplicationError(409, "The selected Library version cannot fill this slot");
        }
        const index = input.document.replaceEntryId
          ? entries.findIndex(({ id }) => id === input.document!.replaceEntryId) : -1;
        if ((input.document.replaceEntryId &&
            (index < 0 || entries[index].kindId !== slot.id)) ||
            (!input.document.replaceEntryId && !slot.repeatable &&
             entries.some(({ kindId }) => kindId === slot.id))) {
          throw new ApplicationError(409, "Select the exact existing slot entry to replace");
        }
        entryId = input.document.replaceEntryId ?? randomUUID();
        const lastSeen = { name: version.filename, size: version.size_bytes,
          modified: Date.parse(version.created_at) || 0, sha256: version.source_sha256 };
        const entry = index < 0 ? { id: entryId, kindId: slot.id,
          title: slot.repeatable ? withoutExtension(version.filename) : slot.label, lastSeen }
          : { ...entries[index], lastSeen };
        if (index < 0) entries.push(entry); else entries[index] = entry;
        bindings[entryId] = { kind: "document", documentId: input.document.documentId,
          version: "latest" };
      }
      const changed = profileId !== state.profileId || filled.length > 0 || !!entryId;
      if (!changed) return { product: record, filled, entryId };
      return { filled, entryId, product: await workProducts.save(scope, record.id, {
        revision: input.revision,
        state: { ...record.state, profileId, cover, entries, bindings },
      }) };
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

export type CourtRecordsApplication = ReturnType<typeof createCourtRecordsApplication>;
