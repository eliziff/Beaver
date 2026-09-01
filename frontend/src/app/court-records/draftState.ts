import { fileSnapshot, type WorkProduct } from "@/app/lib/workProducts";
import { needsOcr, type CourtRecordsHost, type PreparationProgress } from "./host";
import type { CourtRecordDraft, CoverValues, RecordEntry } from "./types";

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
