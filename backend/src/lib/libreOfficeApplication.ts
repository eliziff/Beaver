import { createHash } from "node:crypto";
import { runLibreOffice } from "./libreOffice";
import { parseResourceReference, resourceReference } from "./resourceReferences";
import type { DocumentContent, DocumentRecord, DocumentStore } from "./documentStore";

const RECEIPT = "uno-preview.json";
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
type Options = { documents: DocumentStore; userId: string; userEmail?: string;
  matterId?: string | null; docIndex?: Record<string, { document_id: string; version_id?: string | null }>;
  allowedDocumentIds?: Set<string>; editMode?: "manual" | "auto"; turnId?: string;
  onMutationCommitted(): void;
  onPublished(documentId: string, versionId: string, workingRevision: number, sourceVersion: string): void;
};
type Receipt = { schema: 1; source: string; workingRevision: number;
  sourceSha256: string; candidateSha256: string; report: Record<string, unknown> };
export type UnoApplicationResult = { report: Record<string, unknown>;
  publication?: { id: string; version: string; number: number; filename: string; action: "created" | "edited" } };
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Existing document ports own access and CAS publication; UNO only produces candidates. */
export function createLibreOfficeApplication(options: Options, execute = runLibreOffice) {
  const scope = { userId: options.userId, userEmail: options.userEmail };
  const created = new Set<string>();
  const published = new Map<string, UnoApplicationResult>();
  const loaded = async (raw: string): Promise<{ reference: string; meta: DocumentRecord; file: DocumentContent }> => {
    const reference = raw;
    const parsed = parseResourceReference(reference);
    if (parsed?.kind !== "document") throw new Error("Use a version-pinned DOCX resource from Glob");
    if (options.allowedDocumentIds && !options.allowedDocumentIds.has(parsed.documentId) && !created.has(parsed.documentId))
      throw new Error("Document is outside the selected scope");
    const meta = await options.documents.metadata(scope, parsed.documentId);
    const indexed = Object.values(options.docIndex ?? {}).some((d) =>
      d.document_id === parsed.documentId && d.version_id === parsed.versionId);
    if (!meta || !(indexed || created.has(meta.id) || (options.matterId
      ? meta.project_id === options.matterId : meta.project_id === null && meta.library_kind === "file")))
      throw new Error("Document is outside the current workspace");
    const file = await options.documents.read(scope, meta.id, parsed.versionId, false);
    if (!file || file.fileType !== "docx" || file.version.id !== parsed.versionId)
      throw new Error("DOCX version is unavailable");
    return { reference, meta, file };
  };
  const artifact = (id: string, version: string, number: number, filename: string,
    action: "created" | "edited", report: Record<string, unknown>): UnoApplicationResult => ({
    report: { ...report, resource: resourceReference.document(id, version) },
    publication: { id, version, number, filename, action },
  });
  return async (input: Record<string, unknown>, signal: AbortSignal, restricted = false): Promise<UnoApplicationResult> => {
    signal.throwIfAborted();
    if (restricted) throw new Error("Whole-document UNO access is unavailable in a restricted research selection");
    const source = await loaded(String(input.file_path));
    const unchanged = () => source.meta.current_version_id === source.file.version.id &&
      source.meta.current_working_revision === source.file.version.working_revision;
    if (input.action === "apply") {
      if (options.editMode !== "auto") throw new Error("UNO candidates are direct edits. Review/download the copy or select Direct mode before applying");
      const preview = await loaded(String(input.preview_resource ?? ""));
      const key = source.reference + ":" + preview.reference;
      if (published.has(key)) return { report: { ...published.get(key)!.report, already_applied: true } };
      const parts = await options.documents.readParts(scope, preview.meta.id, preview.file.version.id, [RECEIPT]);
      const raw: unknown = JSON.parse(parts?.[0]?.bytes.toString("utf8") ?? "null");
      if (!record(raw) || raw.schema !== 1 || raw.source !== source.reference ||
        raw.workingRevision !== source.file.version.working_revision || raw.sourceSha256 !== hash(source.file.bytes) ||
        raw.candidateSha256 !== hash(preview.file.bytes) || !record(raw.report) || raw.report.reopened !== true)
        throw new Error("Preview receipt does not match these source and candidate versions");
      if (!unchanged()) throw new Error("Source changed; create a new preview");
      signal.throwIfAborted();
      options.onMutationCommitted(); // Fence uncertain persistent writes against automatic replay.
      const version = await options.documents.addVersion(scope, source.meta.id, {
        filename: source.file.filename, fileType: "docx", bytes: preview.file.bytes,
        expectedCurrentVersionId: source.file.version.id,
        expectedCurrentWorkingRevision: source.file.version.working_revision,
        expectedCurrentSha256: hash(source.file.bytes),
        provenance: { schemaVersion: 1, actor: "assistant", action: "revised", turnId: options.turnId },
        comment: "Applied inspected LibreOffice candidate (direct edits)",
      });
      if (!version) throw new Error("Source changed or is no longer writable; nothing was published");
      options.onPublished(source.meta.id, version.id, version.working_revision, source.file.version.id);
      const outcome = artifact(source.meta.id, version.id, version.version_number, source.file.filename,
        "edited", { ok: true, mode: "direct", preview_resource: preview.reference });
      published.set(key, outcome);
      return outcome;
    }
    if (!["inspect", "describe", "preview"].includes(String(input.action))) throw new Error("Unknown Word action");
    if (input.action === "describe" && !input.target) throw new Error("describe requires a target");
    if (input.action === "preview" && (!unchanged() || input.snapshot !== hash(source.file.bytes)))
      throw new Error("Preview requires an inspected current snapshot");
    const { file_path: _path, preview_resource: _preview, ...request } = input;
    const result = await execute(source.file.bytes, request, signal);
    if (!result.candidate) return { report: result.report };
    signal.throwIfAborted();
    const receipt: Receipt = { schema: 1, source: source.reference,
      workingRevision: source.file.version.working_revision, sourceSha256: hash(source.file.bytes),
      candidateSha256: hash(result.candidate), report: result.report };
    options.onMutationCommitted();
    const copy = await options.documents.create(scope, {
      filename: source.file.filename.replace(/\.docx$/iu, " (UNO preview).docx"), fileType: "docx", bytes: result.candidate,
      projectId: source.meta.project_id, folderId: source.meta.project_id ? source.meta.folder_id : source.meta.library_folder_id,
      libraryKind: "file", parts: [{ name: RECEIPT, bytes: Buffer.from(JSON.stringify(receipt)) }],
      provenance: { schemaVersion: 1, actor: "assistant", action: "created", turnId: options.turnId },
    });
    created.add(copy.id); options.allowedDocumentIds?.add(copy.id);
    return artifact(copy.id, copy.current_version_id, copy.active_version_number, copy.filename, "created",
      { ...result.report, original_unchanged: true, source: source.reference });
  };
}
