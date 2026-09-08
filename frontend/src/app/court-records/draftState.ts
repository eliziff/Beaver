import { fileSnapshot, type WorkProduct } from "@/app/lib/workProducts";
import type { Document } from "@/app/lib/api/documents";
import { type CourtRecordsHost, type PreparationProgress } from "./host";
import { COURT_PROFILE_BY_ID } from "./profiles";
import { propagatingSourceFields, sourceExhibitSlots } from "./types";
import type { CourtRecordDraft, CoverValues, RecordEntry, SourceDocumentFields } from "./types";

const UNASSIGNED_KIND_ID = "unassigned";

/** Replay local edits on a newer revision; entries and parties merge by identity. */
export function rebaseDraft<T>(base: T, local: T, remote: T): T {
  if (local instanceof Blob || base instanceof Blob) return local === base ? remote : local;
  if (JSON.stringify(base) === JSON.stringify(local)) return remote;
  if (Array.isArray(local) && Array.isArray(remote) && Array.isArray(base) &&
      [...base, ...local, ...remote].every((item) => item && typeof item.id === "string")) {
    const keyed = (items: typeof local) => Object.fromEntries(items.map((item) => [item.id, item]));
    const merged = rebaseDraft(keyed(base), keyed(local), keyed(remote));
    return [...new Set([...local, ...remote].map((item) => item.id))]
      .flatMap((id) => merged[id] === undefined ? [] : [merged[id]]) as T;
  }
  if (local && remote && Object.getPrototypeOf(local) === Object.prototype &&
      Object.getPrototypeOf(remote) === Object.prototype) {
    const before = (base ?? {}) as Record<string, unknown>, next = local as Record<string, unknown>;
    const latest = remote as Record<string, unknown>;
    return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(next),
      ...Object.keys(latest)])].flatMap((key) => {
      const value = rebaseDraft(before[key], next[key], latest[key]);
      return value === undefined ? [] : [[key, value]];
    })) as T;
  }
  return local;
}

export function courtRecordDraftFromDocuments(profileId: string,
  documents: Array<Pick<Document, "id" | "filename"> &
  Partial<Pick<Document, "size_bytes" | "created_at" | "source_sha256">>>): CourtRecordDraft {
  const entries = documents.map((document) => ({
    id: document.id,
    kindId: UNASSIGNED_KIND_ID,
    title: document.filename.replace(/\.(?:pdf|docx)$/iu, ""),
    lastSeen: { name: document.filename, size: document.size_bytes ?? 0,
      modified: Date.parse(document.created_at ?? "") || 0,
      ...(document.source_sha256 ? { sha256: document.source_sha256 } : {}) },
  }));
  return { profileId, cover: {}, entries,
    bindings: Object.fromEntries(documents.map(({ id }) => [id,
      { kind: "document", documentId: id, version: "latest" }])) };
}

export function courtRecordDraft(
  profileId: string,
  cover: CoverValues,
  entries: RecordEntry[],
): CourtRecordDraft {
  const exhibits = sourceExhibitSlots(entries);
  const assigned = new Set<string>();
  return {
    profileId,
    cover,
    entries: entries.map((entry) => {
      const label = entry.exhibitLabel?.trim().toUpperCase();
      const exhibitLabel = entry.kindId === "exhibit" && label &&
        exhibits?.labels.includes(label) && !assigned.has(label) ? label : undefined;
      if (exhibitLabel) assigned.add(exhibitLabel);
      return {
        id: entry.id, kindId: entry.kindId, title: entry.title, date: entry.date || undefined,
        rule70CountedPages: entry.rule70CountedPages, exhibitLabel,
        sourceExhibits: entry.kindId === "affidavit" && exhibits?.labels.length ? exhibits : undefined,
        sourceFields: entry.sourceFields, descriptionOnly: entry.descriptionOnly || undefined,
        ocrAttemptedPages: entry.ocrAttemptedPages,
        nonTextPagesConfirmed: entry.nonTextPagesConfirmed || undefined,
        lastSeen: entrySnapshot(entry),
      };
    }),
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
  const profile = COURT_PROFILE_BY_ID.get(draft.state.profileId);
  async function restore(saved: CourtRecordDraft["entries"][number]): Promise<RecordEntry> {
    const { lastSeen, ocrAttemptedPages, nonTextPagesConfirmed, ...values } = saved;
    // What recognition already found for these bytes; re-reading them finds nothing new.
    const recognised = { ...(ocrAttemptedPages ? { ocrAttemptedPages } : {}),
      ...(nonTextPagesConfirmed ? { nonTextPagesConfirmed } : {}) };
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
    if (binding.kind !== "work-product-output" && existing &&
        JSON.stringify(existing.binding) === JSON.stringify(binding) &&
        JSON.stringify(entrySnapshot(existing)) === JSON.stringify(lastSeen)) {
      return applySourceEntryFields({ ...existing, ...values, lastSeen,
        ...recognised, binding, inputStatus: "ready" }, undefined, saved.sourceFields);
    }
    const destination = profile?.documentKinds.find(({ id }) => id === saved.kindId);
    const resolved = await host.resolveInput(binding, progress, destination);
    if (resolved.status === "missing") return missingEntry(saved, resolved.reason, binding);
    const prepared = resolved.prepared ?? await host.prepareDeviceFile(resolved.file, progress);
    const changed = resolved.status === "changed" || !!(
      lastSeen.sha256 && prepared.origin?.sourceSha256 &&
      lastSeen.sha256 !== prepared.origin.sourceSha256
    );
    return applySourceEntryFields({
      ...values,
      ...prepared,
      ...(changed ? {} : recognised),
      binding: resolved.input,
      inputStatus: resolved.status === "stale" ? "stale" : changed ? "changed" : "ready",
    }, undefined, saved.sourceFields);
  }

  const entries: RecordEntry[] = [];
  for (let offset = 0; offset < draft.state.entries.length; offset += 4)
    entries.push(...await Promise.all(draft.state.entries.slice(offset, offset + 4).map(restore)));
  const exhibits = sourceExhibitSlots(entries);
  return entries.map((entry) => entry.kindId === "affidavit"
    ? { ...entry, sourceExhibits: exhibits?.labels.length ? exhibits : undefined } : entry);
}

export function applySourceEntryFields(entry: RecordEntry, replaceTitle?: string,
  previous?: SourceDocumentFields): RecordEntry {
  const source = propagatingSourceFields(entry);
  if (!source) return entry;
  const sourcedTitle = !!previous?.entryTitle && entry.title === previous.entryTitle;
  const sourcedDate = !!previous?.entryDate && entry.date === previous.entryDate;
  return {
    ...entry,
    title: source.entryTitle && (!entry.title.trim() || entry.title === replaceTitle || sourcedTitle)
      ? source.entryTitle : sourcedTitle ? "" : entry.title,
    date: source.entryDate && (!entry.date?.trim() || sourcedDate)
      ? source.entryDate : sourcedDate ? undefined : entry.date,
  };
}

function entrySnapshot(entry: RecordEntry) {
  const sha256 = entry.origin?.sourceSha256 ?? (entry.binding?.kind === "local-file"
    ? entry.binding.lastSeen.sha256 : undefined);
  return { ...(entry.lastSeen ?? fileSnapshot(entry.file)),
    ...(sha256 ? { sha256 } : {}) };
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
