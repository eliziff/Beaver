import { fileSnapshot, type WorkProduct } from "@/app/lib/workProducts";
import type { Document } from "@/app/components/shared/types";
import { needsOcr, type CourtRecordsHost, type PreparationProgress } from "./host";
import type { CourtRecordDraft, CoverValues, RecordEntry } from "./types";

const UNASSIGNED_KIND_ID = "unassigned";

export function courtRecordDraftFromDocuments(documents: Array<Pick<Document, "id" | "filename"> &
  Partial<Pick<Document, "size_bytes" | "created_at" | "source_sha256">>>): CourtRecordDraft {
  const entries = documents.map((document) => ({
    id: document.id,
    kindId: UNASSIGNED_KIND_ID,
    title: document.filename.replace(/\.(?:pdf|docx)$/iu, ""),
    lastSeen: { name: document.filename, size: document.size_bytes ?? 0,
      modified: Date.parse(document.created_at ?? "") || 0,
      ...(document.source_sha256 ? { sha256: document.source_sha256 } : {}) },
  }));
  return { profileId: "", cover: {}, entries,
    bindings: Object.fromEntries(documents.map(({ id }) => [id,
      { kind: "document", documentId: id, version: "latest" }])) };
}

export function courtRecordDraft(
  profileId: string,
  cover: CoverValues,
  entries: RecordEntry[],
): CourtRecordDraft {
  return {
    profileId,
    cover,
    entries: entries.map((entry) => ({
      id: entry.id,
      kindId: entry.kindId,
      title: entry.title,
      ...(entry.date ? { date: entry.date } : {}),
      ...(entry.exhibitLabel ? { exhibitLabel: entry.exhibitLabel } : {}),
      ...(entry.descriptionOnly ? { descriptionOnly: true } : {}),
      lastSeen: entrySnapshot(entry),
    })),
    bindings: Object.fromEntries(entries.flatMap((entry) =>
      entry.binding ? [[entry.id, entry.binding]] : [])),
  };
}

export async function restoreCourtRecordDraft(
  draft: WorkProduct<CourtRecordDraft>,
  host: CourtRecordsHost,
  progress?: PreparationProgress,
  current: RecordEntry[] = [],
): Promise<RecordEntry[]> {
  const currentById = new Map(current.map((entry) => [entry.id, entry]));
  return Promise.all(draft.state.entries.map(async (saved): Promise<RecordEntry> => {
    const { lastSeen, ...values } = saved;
    if (saved.descriptionOnly) return {
      ...values,
      file: new File([], "description-only"),
      pageCount: 0,
      searchable: null,
      encrypted: null,
      inputStatus: "ready",
    };
    const binding = draft.state.bindings[saved.id];
    if (!binding) return missingEntry(saved, "unavailable");
    const existing = currentById.get(saved.id);
    if (existing && JSON.stringify(existing.binding) === JSON.stringify(binding) &&
        JSON.stringify(entrySnapshot(existing)) === JSON.stringify(lastSeen)) {
      return withOcr(host, { ...existing, ...values, lastSeen, binding,
        inputStatus: "ready" }, progress);
    }
    try {
      const resolved = await host.resolveInput(binding, progress);
      if (resolved.status === "missing") return missingEntry(saved, resolved.reason, binding);
      const prepared = resolved.prepared ?? await host.prepareDeviceFile(resolved.file, progress);
      const changed = resolved.status === "changed" || !!(
        lastSeen.sha256 && prepared.origin?.sourceSha256 &&
        lastSeen.sha256 !== prepared.origin.sourceSha256
      );
      return withOcr(host, {
        ...values,
        ...prepared,
        binding: resolved.input,
        inputStatus: changed ? "changed" : "ready",
      }, progress);
    } catch {
      return missingEntry(saved, "unavailable", binding);
    }
  }));
}

async function withOcr(
  host: CourtRecordsHost,
  entry: RecordEntry,
  progress?: PreparationProgress,
): Promise<RecordEntry> {
  if (!host.runOcr || !needsOcr(entry)) return entry;
  try {
    return { ...entry, ...await host.runOcr(entry, progress) };
  } catch (error) {
    return { ...entry,
      inspectionError: error instanceof Error ? error.message : "OCR failed." };
  }
}

function entrySnapshot(entry: RecordEntry) {
  return { ...(entry.lastSeen ?? fileSnapshot(entry.file)),
    ...(entry.origin?.sourceSha256 ? { sha256: entry.origin.sourceSha256 } : {}) };
}

function missingEntry(
  saved: CourtRecordDraft["entries"][number],
  reason: NonNullable<RecordEntry["missingReason"]>,
  binding?: RecordEntry["binding"],
): RecordEntry {
  const { lastSeen, ...values } = saved;
  return {
    ...values,
    file: new File([], lastSeen.name, { lastModified: lastSeen.modified }),
    lastSeen,
    pageCount: null,
    searchable: null,
    encrypted: null,
    binding,
    inputStatus: "missing",
    missingReason: reason,
  };
}
