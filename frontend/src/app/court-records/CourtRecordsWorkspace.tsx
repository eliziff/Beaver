import { lazy, Suspense, useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
/** Loaded on demand: the picker reaches Beaver's Library, which the standalone bundle must not preload. */
const AddDocumentsModal = lazy(() => import("@/app/components/modals/AddDocumentsModal")
  .then((m) => ({ default: m.AddDocumentsModal })));
import { Settings2 } from "lucide-react";
import type { Document } from "@/app/lib/api/documents";
import { cn } from "@/app/lib/utils";
import { CourtRecordBuildPanel } from "./CourtRecordBuildPanel";
import { CourtRecordDocuments, type OcrRun } from "./CourtRecordDocuments";
import { WorkspaceHeader } from "@/app/components/shared/WorkspaceHeader";
import { Button } from "@/app/components/ui/button";
import { Pagination } from "@/app/components/shared/TablePrimitive";
import { SearchBar } from "@/app/components/ui/search-bar";
import { Modal } from "@/app/components/modals/Modal";
import { OutputFolderSetting } from "@/app/components/shared/OutputFolderSetting";
import { applySourceEntryFields, courtRecordDraft, courtRecordDraftFromDocuments, rebaseDraft, restoreCourtRecordDraft } from "./draftState";
import { sourceAccept, sourceFormat } from "./formats";
import { CourtRecordChooser, CourtRecordSetup } from "./CourtRecordSetup";
import { downloadArtifact, FILING_CONTACT_FIELDS, needsOcr, type CourtRecordsHost,
  type DraftOutputChoice, type FilingContactCover, type SelectedFile } from "./host";
import { COURT_PROFILE_BY_ID } from "./profiles";
import type { WorkProduct, WorkProductMetadata, WorkProductRefresh } from "@/app/lib/workProducts";
import { errorMessage, formatDateTime } from "@/app/lib/utils";
import type {
  BuildResult,
  BuildArtifact,
  ComplianceFinding,
  CourtRecordDraft,
  CoverFieldId,
  CoverValues,
  CourtProfile,
  DocumentKind,
  RecordEntry,
  SourceDocumentFields,
} from "./types";
import { exhibitName, propagatingSourceFields, sourceExhibitSlots } from "./types";
import { staleBuildSource, validateCourtRecord } from "./validation";

const DEFAULT_PROFILE_ID = "general-affidavit-exhibits";
const SAVE_DELAY = 300;

/** The open draft: the revision the server holds, the state edited here, and the live files. */
type DraftView = { profileId: string; cover: CoverValues; entries: RecordEntry[] };
type OpenDraft = DraftView & { product: WorkProduct<CourtRecordDraft>; state: CourtRecordDraft };
const NO_DRAFT: DraftView = { profileId: DEFAULT_PROFILE_ID, cover: {}, entries: [] };
const NO_OPEN = { id: "", revision: 0, request: 0 };

export function CourtRecordsWorkspace({ host, headerActions, onDraftChange, refreshToken,
  initialDraftId, initialDocuments, onDocumentsConsumed, projectId, locked = false, jurisdictionOrder = [] }: {
  host: CourtRecordsHost;
  headerActions?: ReactNode;
  onDraftChange?: (draft: WorkProduct<CourtRecordDraft> | undefined, synced: boolean) => void;
  refreshToken?: WorkProductRefresh;
  initialDraftId?: string;
  initialDocuments?: Parameters<typeof courtRecordDraftFromDocuments>[1];
  onDocumentsConsumed?: () => void;
  projectId?: string;
  locked?: boolean;
  jurisdictionOrder?: string[];
}) {
  const [session, setSession] = useState<OpenDraft>();
  const [drafts, setDrafts] = useState<WorkProductMetadata[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draftBusy, setDraftBusy] = useState(!!initialDraftId);
  const [creating, setCreating] = useState(false);
  const pendingDocuments = useRef(initialDraftId ? undefined : initialDocuments);
  const [savedOpen, setSavedOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busyEntryId, setBusyEntryId] = useState<string>();
  const [progress, setProgress] = useState<string>();
  const [reading, setReading] = useState<OcrRun>();
  const [error, setError] = useState<string>();
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingFilingContact, setSavingFilingContact] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [restoredEmpty, setRestoredEmpty] = useState(false);
  const [result, setResult] = useState<BuildResult>();
  const [sourceKindId, setSourceKindId] = useState<string>();
  const [sourceEntryId, setSourceEntryId] = useState<string>();
  const [sourceExhibitLabel, setSourceExhibitLabel] = useState<string>();
  const [importingSource, setImportingSource] = useState(false);
  const routeLoading = useRef(false);
  const sessionRef = useRef(session);
  /** Which open is authoritative: a later request wins, an older revision never does. */
  const opening = useRef(NO_OPEN);
  const saveQueue = useRef(Promise.resolve<WorkProduct<CourtRecordDraft> | undefined>(undefined));
  const { profileId, cover, entries } = session ?? NO_DRAFT;
  const draft = session?.product;
  const unsaved = !!session && session.state !== session.product.state;
  const profile = COURT_PROFILE_BY_ID.get(profileId) ?? COURT_PROFILE_BY_ID.get(DEFAULT_PROFILE_ID)!;
  const isAffidavit = profile.family === "affidavit";
  const hasCaseDetails = !!(profile.cover.fields.length || profile.cover.partyStyles?.length);
  const operationBusy = draftBusy || building || saving || !!busyEntryId || importingSource || !!reading;
  const openDraftEffect = useEffectEvent(openDraft);
  const saveDraftEffect = useEffectEvent(saveCurrentDraft);
  const refreshDraftEffect = useEffectEvent(refreshDraft);
  const clearDraftEffect = useEffectEvent(clearDraft);
  const readEntryEffect = useEffectEvent(ocr);
  useEffect(() => {
    if (!host.runOcr || draftBusy || building || busyEntryId || importingSource || reading) return;
    const next = entries.find((entry) => entry.inputStatus !== "missing" &&
      sourceFormat(entry.file) === "pdf" && needsOcr(entry));
    if (next) void readEntryEffect(next);
  }, [host, entries, draftBusy, building, busyEntryId, importingSource, reading]);

  useEffect(() => () => { void saveDraftEffect(); }, []);

  useEffect(() => {
    let cancelled = false;
    setDrafts([]);
    setDraftsLoading(true);
    void (async () => {
      const saved = host.drafts.listMetadata
        ? await host.drafts.listMetadata("court-record", projectId)
        : (await host.drafts.list<CourtRecordDraft>("court-record", projectId))
          .map(({ state, ...item }) => ({ ...item, profileId: state.profileId }));
      if (!cancelled) setDrafts((current) => [...new Map(
        [...saved, ...current].map((item) => [item.id, item])).values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    })().catch((caught) => {
      if (!cancelled) setError(errorMessage(caught, "Saved records could not be listed."));
    }).finally(() => {
      if (!cancelled) setDraftsLoading(false);
    });
    return () => { cancelled = true; };
  }, [host, projectId]);

  useEffect(() => {
    const current = sessionRef.current?.product;
    if (initialDraftId && initialDraftId === current?.id &&
        (current.projectId ?? "") === (projectId ?? "")) return;
    let cancelled = false;
    routeLoading.current = !!initialDraftId || !!current;
    setDraftBusy(routeLoading.current);
    void (async () => {
      if (sessionRef.current && !await saveDraftEffect()) return;
      if (cancelled) return;
      if (!initialDraftId) {
        clearDraftEffect();
        setCreating(!!pendingDocuments.current?.length);
        return;
      }
      const requested = await host.drafts.get<CourtRecordDraft>(initialDraftId);
      if (requested.kind !== "court-record") throw new Error("This is not a Court Record draft.");
      if (!cancelled) await openDraftEffect(requested);
    })().catch((caught) => {
      if (!cancelled) {
        if (projectId && sessionRef.current?.product.projectId !== projectId) clearDraftEffect();
        setError(errorMessage(caught, "Drafts could not be opened."));
      }
    }).finally(() => { if (!cancelled) {
      routeLoading.current = false;
      setDraftBusy(false);
    } });
    return () => { cancelled = true; cancelOpen(); };
  }, [host, initialDraftId, projectId]);

  useEffect(() => {
    if (!initialDraftId && initialDocuments?.length) {
      pendingDocuments.current = initialDocuments;
      if (!routeLoading.current) setCreating(true);
    }
  }, [initialDraftId, initialDocuments]);

  useEffect(() => {
    onDraftChange?.(draft, !routeLoading.current && !operationBusy && !unsaved);
  }, [draft, operationBusy, unsaved, onDraftChange]);

  useEffect(() => {
    if (draft?.id && refreshToken?.id === draft.id) void refreshDraftEffect(refreshToken.revision);
  }, [draft?.id, refreshToken]);

  useEffect(() => {
    if (!unsaved || draftBusy || building || saving || busyEntryId || importingSource) return;
    const timer = setTimeout(() => void saveDraftEffect(), SAVE_DELAY);
    return () => clearTimeout(timer);
  }, [session, unsaved, draftBusy, building, saving, busyEntryId, importingSource]);

  const report = useMemo(() => validateCourtRecord({
    profile,
    entries,
    cover,
  }), [profile, entries, cover]);
  const missingFields = useMemo(() => new Set(showErrors ? report.blockers.flatMap((item) => item.fieldId ? [item.fieldId] : []) : []), [report.blockers, showErrors]);
  const entryFindings = useMemo(() => findingsByEntry([...report.blockers, ...report.review]), [report]);

  function invalidate() {
    setResult(undefined);
    setError(undefined);
  }

  function commit(next?: OpenDraft) { setSession(sessionRef.current = next); }

  /** Every edit lands here: one next draft state, kept by reference when nothing changed. */
  function edit(change: (current: OpenDraft) => DraftView) {
    const current = sessionRef.current;
    if (!current) return;
    const next = change(current);
    if (next.profileId === current.profileId && next.cover === current.cover &&
        next.entries === current.entries) return;
    const state = courtRecordDraft(next.profileId, next.cover, next.entries);
    commit({ ...current, ...next,
      state: sameState(state, current.state) ? current.state : state });
  }

  /** A prepared entry takes its place and lends its source fields to the cover. */
  function putEntry(entry: RecordEntry, label?: string) {
    edit((current) => ({ ...current, cover: sourceCover(current, entry),
      entries: putPreparedEntry(current.entries, entry, label) }));
    if (propagatingSourceFields(entry)) invalidate();
  }

  function sourceCover(view: DraftView, entry: RecordEntry) {
    if (!propagatingSourceFields(entry)) return view.cover;
    return fillSourceCover(COURT_PROFILE_BY_ID.get(view.profileId) ?? profile, view.cover,
      [...coverSourceFields(view.entries.filter(({ id }) => id !== entry.id)),
        entry.sourceFields!], coverSourceFields(view.entries));
  }

  function cancelOpen() { opening.current = { ...NO_OPEN, request: opening.current.request + 1 }; }

  function listDraft(next: WorkProduct<CourtRecordDraft>) {
    if (projectId && next.projectId !== projectId) return;
    const { state, ...metadata } = next;
    setDrafts((current) => [{ ...metadata, profileId: state.profileId },
      ...current.filter((item) => item.id !== next.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  /** Adopt a revision the server just returned, keeping edits made while it was in flight. */
  function adoptProduct(next: WorkProduct<CourtRecordDraft>, sent?: CourtRecordDraft) {
    const current = sessionRef.current;
    if (current?.product.id === next.id && next.revision >= current.product.revision) {
      commit({ ...current, product: next,
        state: current.state === (sent ?? current.product.state) ? next.state : current.state });
    }
    listDraft(next);
  }

  function clearDraft() {
    cancelOpen();
    commit(undefined);
    setResult(undefined); setShowErrors(false);
    setCreating(false); setSavedOpen(false);
    setSourceKindId(undefined); setSourceExhibitLabel(undefined);
    setReading(undefined);
    setError(undefined); setProgress(undefined); setRestoredEmpty(false);
  }

  function saveCurrentDraft(): Promise<WorkProduct<CourtRecordDraft> | undefined> {
    return saveQueue.current = saveQueue.current.then(() => pushDraft().catch((caught) => {
      setError(errorMessage(caught, "This draft could not be saved."));
      return undefined;
    }));
  }

  /** Send the draft on the revision it was based on; a conflict reopens and rebases here. */
  async function pushDraft(): Promise<WorkProduct<CourtRecordDraft> | undefined> {
    for (;;) {
      const current = sessionRef.current;
      if (!current) return undefined;
      const { product, state } = current;
      if (state === product.state) return product;
      try {
        const next = await host.drafts.update<CourtRecordDraft>(product.id,
          { revision: product.revision, state });
        if (!next || sessionRef.current?.product.id !== product.id) return next;
        adoptProduct(next, state);
      } catch (caught) {
        const latest = await host.drafts.get<CourtRecordDraft>(product.id);
        if (latest.revision <= product.revision) throw caught;
        await openDraft(latest);
        const rebased = sessionRef.current;
        if (rebased?.product.id !== product.id ||
            rebased.product.revision < latest.revision) throw caught;
      }
    }
  }

  async function openDraft(next: WorkProduct<CourtRecordDraft>, wasNew = false) {
    if (projectId && next.projectId !== projectId) {
      throw new Error("This Court Record draft is not in this project.");
    }
    if (opening.current.id === next.id && opening.current.revision > next.revision) return;
    const request = opening.current.request + 1;
    opening.current = { id: next.id, revision: next.revision, request };
    const before = sessionRef.current, resumed = before?.product.id === next.id;
    setDraftBusy(true);
    setError(undefined);
    setReading(undefined);
    setProgress("Opening draft");
    try {
      const state = resumed ? rebaseDraft(before.product.state, before.state, next.state)
        : next.state;
      const definition = COURT_PROFILE_BY_ID.get(state.profileId);
      if (!definition) throw new Error("This filing format is not available.");
      const live = before?.entries ?? [];
      const restored = await restoreCourtRecordDraft({ ...next, state }, host, (message) => {
        if (request === opening.current.request) setProgress(message);
      }, resumed ? live : []);
      const now = sessionRef.current;
      if (request !== opening.current.request ||
          now?.product.id === next.id && now.product.revision > next.revision) return;
      const entries = fillExhibitLabels(rebaseDraft(live, now?.entries ?? live, restored));
      const cover = fillSourceCover(definition,
        rebaseDraft(before?.cover ?? {}, now?.cover ?? before?.cover ?? {}, state.cover),
        coverSourceFields(entries), coverSourceFields(state.entries));
      const edited = courtRecordDraft(definition.id, cover, entries);
      commit({ product: next, profileId: definition.id, cover, entries,
        state: sameState(edited, next.state) ? next.state : edited });
      setResult(undefined);
      setShowErrors(false);
      setCreating(false);
      setRestoredEmpty(!wasNew && next.state.entries.length === 0); listDraft(next);
    } catch (caught) {
      if (request === opening.current.request) {
        setError(errorMessage(caught, "This draft could not be opened."));
      }
    } finally {
      if (request === opening.current.request) {
        setProgress(undefined);
        if (!routeLoading.current) setDraftBusy(false);
      }
    }
  }

  async function refreshDraft(expectedRevision = 0) {
    const current = sessionRef.current?.product;
    if (!current || current.revision >= expectedRevision) return;
    try {
      const latest = await host.drafts.get<CourtRecordDraft>(current.id);
      const active = sessionRef.current?.product;
      if (active?.id === current.id && latest.revision >= expectedRevision &&
          latest.revision > active.revision) {
        await openDraft(latest);
      }
    } catch (caught) {
      setError(errorMessage(caught, "This draft could not be refreshed."));
    }
  }

  async function newDraft(nextProfileId: string) {
    setCreating(false);
    const nextProfile = COURT_PROFILE_BY_ID.has(nextProfileId) ? nextProfileId : DEFAULT_PROFILE_ID;
    setDraftBusy(true);
    try {
      const definition = COURT_PROFILE_BY_ID.get(nextProfile)!;
      const allowed = new Set<string>(definition.cover.fields.map(({ id }) => id));
      const defaults = Object.fromEntries(Object.entries(await host.newDraftCover?.() ?? {})
        .filter(([field]) => allowed.has(field))) as CoverValues;
      const created = await host.drafts.create({ kind: "court-record",
        title: definition.label, ...(projectId && { projectId }),
        state: { ...courtRecordDraftFromDocuments(nextProfile, pendingDocuments.current ?? []),
          cover: defaults } });
      if (pendingDocuments.current) {
        pendingDocuments.current = undefined;
        onDocumentsConsumed?.();
      }
      await openDraft(created, true);
    } catch (caught) {
      setError(errorMessage(caught, "The court record could not be created."));
      setDraftBusy(false);
    }
  }

  async function openSavedDraft(next: WorkProductMetadata) {
    setSavedOpen(false);
    try {
      await openDraft(await host.drafts.get<CourtRecordDraft>(next.id));
    } catch (caught) {
      setError(errorMessage(caught, "This draft could not be opened."));
      setDraftBusy(false);
    }
  }

  async function closeDraft() {
    if (!await saveCurrentDraft()) return;
    clearDraft();
  }

  async function duplicateDraft() {
    const current = await saveCurrentDraft();
    if (!current) return;
    const created = await host.drafts.duplicate<CourtRecordDraft>(current.id,
      { title: `${current.title} copy`, projectId: current.projectId });
    await openDraft(created, true);
  }

  async function renameDraft(title: string) {
    const current = await saveCurrentDraft();
    if (!current) return;
    try {
      adoptProduct(await host.drafts.update(current.id, { revision: current.revision, title }));
    } catch (caught) {
      setError(errorMessage(caught, "The draft could not be renamed."));
    }
  }

  async function deleteDraft() {
    const current = await saveCurrentDraft();
    if (!current) return;
    setDraftBusy(true);
    try {
      await host.drafts.remove(current.id);
      const remaining = drafts.filter((item) => item.id !== current.id);
      setDrafts(remaining);
      clearDraft();
    } catch (caught) {
      setError(errorMessage(caught, "The draft could not be deleted."));
    } finally {
      setDraftBusy(false);
    }
  }

  async function ocr(entry: RecordEntry) {
    if (!host.runOcr) return;
    const request = opening.current.request;
    setReading({ id: entry.id });
    let patch: Partial<RecordEntry>;
    try {
      patch = await host.runOcr(entry, (message) => {
        if (request === opening.current.request) setReading({ id: entry.id, message });
      });
    } catch {
      patch = { ocrAttemptedPages: [] };
    }
    if (request !== opening.current.request) return;
    const current = sessionRef.current?.entries.find(({ id }) => id === entry.id);
    if (current && current.file === entry.file) {
      putEntry(applySourceEntryFields({ ...current, ...patch }, undefined, current.sourceFields),
        current.exhibitLabel);
    }
    setReading(undefined);
  }

  function chooseProfile(nextId: string) {
    const next = COURT_PROFILE_BY_ID.get(nextId);
    if (!next) return;
    if (next.id === profileId) { setCreating(false); return; }
    const nextKinds = new Set(next.documentKinds.map(({ id }) => id));
    const noteKinds = next.documentKinds.filter(({ descriptionOnly, requirement }) =>
      descriptionOnly && requirement !== "forbidden");
    edit((view) => {
      const sourceFields = coverSourceFields(view.entries);
      const fields = new Set<string>(next.cover.fields.map(({ id }) => id));
      const kept = Object.fromEntries(Object.entries(view.cover)
        .filter(([field]) => fields.has(field))) as CoverValues;
      const styles = next.cover.partyStyles;
      const style = styles?.find(({ id }) => id === view.cover.partyStyleId) ??
        (styles?.length === 1 ? styles[0] : undefined);
      const groups = style && view.cover.partyGroups?.flatMap((group) => {
        const definition = style.groups.find(({ id }) => id === group.id);
        return definition ? [{ ...group, role: definition.role,
          roleBelow: definition.roleBelow }] : [];
      });
      const eligible = new Set(groups?.filter((group) => !next.cover.filingGroupId ||
        group.id === next.cover.filingGroupId).flatMap((group) => group.parties.map(({ id }) => id)));
      const retainedFilers = view.cover.filingPartyIds?.filter((id) => eligible.has(id));
      const filingPartyIds = retainedFilers?.length ? retainedFilers
        : next.cover.filingGroupId ? [...eligible] : undefined;
      const oldKinds = new Set((COURT_PROFILE_BY_ID.get(view.profileId) ?? profile)
        .documentKinds.map(({ id }) => id));
      return { profileId: next.id,
        cover: fillSourceCover(next, style
          ? { ...kept, partyStyleId: style.id, partyGroups: groups, filingPartyIds }
          : kept, sourceFields),
        entries: fillExhibitLabels(view.entries.map((entry) =>
          !oldKinds.has(entry.kindId) || nextKinds.has(entry.kindId) ? entry : {
            ...entry, kindId: entry.descriptionOnly
              ? noteKinds.length === 1 ? noteKinds[0].id : entry.kindId
              : "unassigned",
            exhibitLabel: undefined,
          })) };
    });
    setShowErrors(false);
    setCreating(false);
    invalidate();
  }

  function assignKind(id: string, kindId: string) {
    const kind = profile.documentKinds.find((item) => item.id === kindId &&
      item.requirement !== "forbidden" && !item.generated && !item.descriptionOnly);
    if (!kind) return;
    edit((view) => {
      const assigned = view.entries.find((entry) => entry.id === id);
      return { ...view,
        cover: assigned ? sourceCover(view, applySourceEntryFields({ ...assigned, kindId }))
          : view.cover,
        entries: fillExhibitLabels(view.entries.map((entry) => entry.id === id
          ? applySourceEntryFields({ ...entry, kindId }) : entry)) };
    });
    invalidate();
  }

  async function addFiles(kindId: string, files: File[], exhibitLabel?: string, entryId?: string) {
    return addSelectedFiles(kindId, files.map((file) => ({ file })), exhibitLabel, entryId);
  }

  async function addSelectedFiles(kindId: string, files: SelectedFile[], exhibitLabel?: string, entryId?: string) {
    const kind = profile.documentKinds.find((item) => item.id === kindId);
    if (!kind || kind.requirement === "forbidden" || !files.length) return;
    const selected = kind.repeatable && !exhibitLabel && !entryId ? files : files.slice(0, 1);
    for (const selection of selected) {
      const { file } = selection;
      const previous = replacementEntry(entries, kind, exhibitLabel, entryId);
      const id = previous?.id ?? crypto.randomUUID();
      const pending: RecordEntry = {
        id,
        kindId,
        file,
        title: previous?.title ?? "",
        ...(previous?.date ? { date: previous.date } : {}),
        ...(previous?.sourceExhibits ? { sourceExhibits: previous.sourceExhibits } : {}),
        pageCount: null,
        searchable: null,
        encrypted: null,
        origin: { kind: "device" },
        binding: selection.input,
      };
      edit((view) => ({ ...view, entries: view.entries.some((entry) => entry.id === id)
        ? view.entries.map((entry) => entry.id === id ? pending : entry)
        : [...view.entries, pending] }));
      setBusyEntryId(id);
      setProgress(`Preparing ${file.name}`);
      invalidate();
      try {
        const prepared = await host.prepareDeviceFile(file, (message) => setProgress(message),
          { workProductId: sessionRef.current?.product.id, destination: kind });
        putEntry(applySourceEntryFields({ ...pending, ...prepared,
          binding: prepared.binding ?? selection.input }, previous ? undefined : pending.title,
        previous?.sourceFields), exhibitLabel);
      } catch (caught) {
        edit((view) => ({ ...view, entries: view.entries.map((entry) => entry.id === id
          ? previous ?? { ...entry,
            inspectionError: errorMessage(caught, "The PDF could not be prepared.") }
          : entry) }));
      } finally {
        setBusyEntryId(undefined);
        setProgress(undefined);
      }
    }
  }

  function addDescription(kindId: string, title?: string) {
    const kind = profile.documentKinds.find((item) => item.id === kindId &&
      (item.descriptionOnly || item.allowUnavailableNote));
    if (!kind) return;
    const id = crypto.randomUUID();
    edit((view) => ({ ...view, entries: [...view.entries, {
      id,
      kindId,
      title: title ?? kind.defaultDescription ?? (kind.allowUnavailableNote
        ? `${kind.label.replace(/^Part [12]\s+—\s+/u, "")} was not available when this appeal record was prepared.`
        : ""),
      file: new File([], "description-only"),
      pageCount: 0,
      searchable: null,
      encrypted: null,
      descriptionOnly: true,
      inputStatus: "ready",
    }] }));
    invalidate();
    if (title === undefined) requestAnimationFrame(() =>
      document.getElementById(`entry-${id}-title`)?.focus());
  }

  async function relinkEntry(id: string) {
    const entry = entries.find((item) => item.id === id);
    if (!entry?.binding || !host.relinkInput) return;
    setBusyEntryId(id);
    setProgress(`Relinking ${entry.file.name}`);
    setError(undefined);
    try {
      const resolved = await host.relinkInput(entry.binding);
      if (resolved.status === "missing") return;
      const prepared = resolved.prepared ?? await host.prepareDeviceFile(resolved.file,
        (message) => setProgress(message), { workProductId: sessionRef.current?.product.id,
          destination: profile.documentKinds.find((kind) => kind.id === entry.kindId) });
      const ready = applySourceEntryFields({
        ...entry,
        ...prepared,
        binding: resolved.input,
        inputStatus: resolved.status,
        missingReason: undefined,
        lastSeen: undefined,
        ocrAttemptedPages: prepared.ocrAttemptedPages,
        nonTextPagesConfirmed: undefined,
      }, undefined, entry.sourceFields);
      edit((view) => ({ ...view, cover: sourceCover(view, ready),
        entries: fillExhibitLabels(view.entries.map((item) => item.id === id ? ready : item)) }));
      invalidate();
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(errorMessage(caught, "The file could not be relinked."));
      }
    } finally {
      setBusyEntryId(undefined);
      setProgress(undefined);
    }
  }

  async function currentInputs(items: RecordEntry[]) {
    return Promise.all(items.map(async (entry) => {
      if (!entry.binding || entry.descriptionOnly) return entry;
      const destination = profile.documentKinds.find(({ id }) => id === entry.kindId);
      const resolved = await host.resolveInput(entry.binding,
        (message) => setProgress(message), destination);
      if (resolved.status === "missing") {
        return { ...entry, inputStatus: "missing" as const, missingReason: resolved.reason };
      }
      const prepared = resolved.prepared ?? await host.prepareDeviceFile(resolved.file,
        (message) => setProgress(message),
        { workProductId: sessionRef.current?.product.id, destination });
      const next: RecordEntry = applySourceEntryFields({ ...entry, ...prepared,
        binding: resolved.input, inputStatus: resolved.status, missingReason: undefined,
        ocrAttemptedPages: resolved.status === "ready"
          ? entry.ocrAttemptedPages : prepared.ocrAttemptedPages,
        nonTextPagesConfirmed: resolved.status === "ready"
          ? entry.nonTextPagesConfirmed : undefined },
      undefined, entry.sourceFields);
      return next;
    }));
  }

  async function build() {
    if (operationBusy || locked) return;
    const sourceMayFill = report.blockers.some(({ fieldId }) => fieldId) &&
      entries.some((entry) => sourceKindMayFillCover(entry.kindId) && entry.binding);
    if (!report.ready && !sourceMayFill) {
      setShowErrors(true);
      setError(report.blockers[0]?.title ?? "Complete the required information.");
      requestAnimationFrame(() => focusFinding(report.blockers[0]));
      return;
    }
    setBuilding(true);
    setError(undefined);
    setResult(undefined);
    try {
      const buildEntries = fillExhibitLabels(await currentInputs(entries));
      const buildCover = fillSourceCover(profile, cover, coverSourceFields(buildEntries),
        coverSourceFields(entries));
      edit((view) => ({ ...view, cover: buildCover, entries: buildEntries }));
      const buildBase = sessionRef.current?.state;
      const buildReport = validateCourtRecord({ profile, entries: buildEntries, cover: buildCover });
      if (!buildReport.ready) {
        setShowErrors(true);
        requestAnimationFrame(() => focusFinding(buildReport.blockers[0]));
        throw new Error(buildReport.blockers[0]?.title ?? "Complete the required information.");
      }
      const built = await (await import("./assembly")).buildCourtRecord({
        profile,
        entries: buildEntries,
        cover: buildCover,
        preparationDate: new Date().toLocaleDateString("en-CA"),
        needsAttention: buildReport.review.map(({ title, detail }) => ({ title, detail })),
        onProgress: (message, completed, total) => setProgress(`${message} · ${completed}/${total}`),
      });
      if (buildBase !== sessionRef.current?.state) {
        throw new Error("The court record changed while it was building. Build it again.");
      }
      setResult(built);
      setProgress("Build complete");
    } catch (caught) {
      setError(errorMessage(caught, "The court record could not be built."));
      setProgress(undefined);
    } finally {
      setBuilding(false);
    }
  }

  async function currentResultEntries() {
    if (!result) return;
    const current = await currentInputs(entries);
    edit((view) => ({ ...view, entries: current }));
    const currentReport = validateCourtRecord({ profile, entries: current, cover });
    const stale = staleBuildSource(result.receipt, current);
    if (currentReport.ready && !stale) return current;
    setResult(undefined);
    setShowErrors(true);
    const blocker = currentReport.blockers[0];
    setError(blocker?.title ?? `${stale?.filename ?? "A source file"} changed. Build the record again.`);
    requestAnimationFrame(() => focusFinding(blocker ?? (stale ? {
      id: `stale-build-${stale.entryId}`, level: "blocker", title: "Source changed",
      detail: "Build the record again.", entryId: stale.entryId,
    } : undefined)));
  }

  async function download(artifact: BuildArtifact) {
    setError(undefined);
    try {
      if (await currentResultEntries()) downloadArtifact(artifact);
    } catch (caught) {
      setError(errorMessage(caught, "The source files could not be refreshed."));
    }
  }

  async function save() {
    if (!result || !host.saveArtifacts) return;
    setSaving(true);
    setError(undefined);
    try {
      const currentEntries = await currentResultEntries();
      if (!currentEntries) return;
      const current = await saveCurrentDraft();
      if (!current) return;
      const saved = await host.saveArtifacts({ artifacts: result.artifacts,
        product: current, entries: currentEntries, receipt: result.receipt });
      adoptProduct(saved.product);
      setProgress(saved.notice ??
        `${result.artifacts.length} file${result.artifacts.length === 1 ? "" : "s"} saved`);
    } catch (caught) {
      setError(errorMessage(caught, "The built files could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  async function saveFilingContact() {
    if (!host.saveFilingContact) return;
    const allowed = new Set(profile.cover.fields.map(({ id }) => id));
    const values = Object.fromEntries(FILING_CONTACT_FIELDS
      .filter((field) => allowed.has(field) && cover[field] !== undefined)
      .map((field) => [field, cover[field]])) as FilingContactCover;
    setSavingFilingContact(true); setError(undefined);
    try {
      await host.saveFilingContact(values);
      setProgress("Filing details saved for new records");
    } catch (caught) {
      setError(errorMessage(caught, "Filing details could not be saved."));
    } finally { setSavingFilingContact(false); }
  }

  const [sourceOutputs, setSourceOutputs] = useState<DraftOutputChoice[]>([]);
  async function openSource(kindId: string, exhibitLabel?: string, entryId?: string) {
    setSourceEntryId(entryId);
    setSourceOutputs([]);
    setSourceKindId(kindId);
    setSourceExhibitLabel(exhibitLabel);
    const current = sessionRef.current?.product;
    const kind = profile.documentKinds.find((item) => item.id === kindId);
    if (current && kind && host.searchDraftOutputs) {
      try { setSourceOutputs(await host.searchDraftOutputs("", kind, current)); }
      catch (caught) { setError(errorMessage(caught, "Available files could not be loaded.")); }
    }
  }

  async function importSource(selected: Document & { draft?: DraftOutputChoice }) {
    if (!sourceKindId || importingSource) return;
    const kindId = sourceKindId, exhibitLabel = sourceExhibitLabel;
    const kind = profile.documentKinds.find((item) => item.id === kindId);
    if (!kind) return;
    setImportingSource(true);
    setError(undefined);
    setResult(undefined);
    try {
      const prepared = selected.draft
        ? await host.importDraftOutput!(selected.draft, kind,
          (message) => setProgress(message))
        : await host.importLibraryDocument!(selected, (message) => setProgress(message), kind);
      const previous = replacementEntry(entries, kind, exhibitLabel, sourceEntryId);
      const entry: RecordEntry = {
        id: previous?.id ?? crypto.randomUUID(),
        kindId,
        title: previous?.title ?? "",
        ...(previous?.date ? { date: previous.date } : {}),
        ...(previous?.sourceExhibits ? { sourceExhibits: previous.sourceExhibits } : {}),
        ...prepared,
      };
      putEntry(applySourceEntryFields(entry,
        previous ? undefined : entry.title, previous?.sourceFields), exhibitLabel);
      setSourceKindId(undefined);
      setSourceExhibitLabel(undefined);
    } catch (caught) {
      setError(errorMessage(caught, "The selected file could not be added."));
    } finally {
      setImportingSource(false);
      setBusyEntryId(undefined);
      setProgress(undefined);
    }
  }

  const sourceKind = profile.documentKinds.find((item) => item.id === sourceKindId);
  const WorkspaceElement = host.mode === "standalone" ? "main" : "div";
  const documents = (heading: string, kindIds?: string[], showUnassigned = false, step?: number) => (
    <CourtRecordDocuments
      profile={profile}
      entries={entries}
      busyEntryId={busyEntryId}
      entryFindings={entryFindings}
      kindIds={kindIds}
      showUnassigned={showUnassigned}
      heading={heading} step={step}
      onFiles={(kindId, files, exhibitLabel) => void addFiles(kindId, files, exhibitLabel)}
      onDescription={addDescription}
      onChoose={(kindId, exhibitLabel, entryId) => void openSource(kindId, exhibitLabel, entryId)}
      onEntry={(id, patch) => { edit((view) => ({ ...view, entries: view.entries.map((entry) =>
        entry.id === id ? { ...entry, ...patch } : entry) })); invalidate(); }}
      onAssign={(id, label) => { edit((view) => ({ ...view,
        entries: assignExhibit(view.entries, id, label) })); invalidate(); }}
      onAddExhibit={() => {
        edit((view) => {
          const slots = sourceExhibitSlots(view.entries);
          const affidavit = view.entries.find((entry) => entry.kindId === "affidavit");
          if (!slots || !affidavit || slots.labels.length >= 702) return view;
          return { ...view, entries: view.entries.map((entry) => entry.id === affidavit.id ? {
            ...entry, sourceExhibits: { sourceSha256: slots.sourceSha256,
              labels: [...slots.labels, exhibitName(slots.labels.length)] },
          } : entry) };
        });
        invalidate();
      }}
      onAssignKind={assignKind}
      onRemove={(id) => { edit((view) => ({ ...view,
        entries: fillExhibitLabels(view.entries.filter((entry) => entry.id !== id)) })); invalidate(); }}
      reading={reading}
      onRelink={host.relinkInput ? (id) => void relinkEntry(id) : undefined}
    />
  );
  const canSaveFilingContact = !!host.saveFilingContact && FILING_CONTACT_FIELDS.some((field) =>
    profile.cover.fields.some(({ id }) => id === field));
  const setup = (step: number) => <CourtRecordSetup
    profile={profile} cover={cover} missingFields={missingFields} heading="Case details" step={step}
    onSaveFilingContact={canSaveFilingContact ? () => void saveFilingContact() : undefined}
    savingFilingContact={savingFilingContact}
    onCover={(field, value) => {
      edit((view) => ({ ...view,
        cover: field === "partyStyleId" && typeof value === "string"
          ? fillSourceCover(profile, { ...view.cover, [field]: value },
            coverSourceFields(view.entries))
          : { ...view.cover, [field]: value } }));
      invalidate();
    }} />;
  const requiredInputs = profile.documentKinds.filter((kind) => kind.requirement === "required" &&
    !kind.generated && !kind.descriptionOnly).sort((left, right) => left.order - right.order);
  const firstInput = requiredInputs[0];
  const initialKind = firstInput && !firstInput.repeatable && sourceKindMayFillCover(firstInput.id)
    ? firstInput : undefined;
  const awaitingSource = !!initialKind && !entries.some((entry) => entry.kindId === initialKind.id && !entry.descriptionOnly);
  const compactLayout = awaitingSource || !profile.cover.generated || profile.outputMode === "separate-files";
  const remainingKinds = profile.documentKinds.filter((kind) => kind.id !== initialKind?.id &&
    kind.requirement !== "forbidden").map(({ id }) => id);
  const actions = <>{host.outputFolder && <Button type="button" variant="outline"
    aria-label="Settings" className="h-9 w-9 shrink-0 border-gray-400 px-0 sm:w-auto sm:px-4"
    disabled={operationBusy || locked}
    onClick={() => setSettingsOpen(true)}>
    <Settings2 /><span className="hidden sm:inline">Settings</span></Button>}{headerActions}</>;
  const headerClass = cn("mx-auto w-full px-4 max-sm:[&_h1]:text-xl sm:px-6 md:mx-auto",
    compactLayout ? "max-w-[48rem]" : "max-w-[70rem]");
  return (
    <div className={cn("court-records-workspace bg-app-background [scrollbar-gutter:stable]", host.mode === "standalone"
      ? "min-h-dvh"
      : "h-full min-h-0 overflow-y-auto")}>
      <a href="#court-record-workspace" className="fixed left-3 top-3 z-50 -translate-y-20 rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-950 shadow focus:translate-y-0 focus:ring-2 focus:ring-red-600">Skip to builder</a>
      {draft ? <WorkspaceHeader className={headerClass} current={draft}
          busy={operationBusy || locked} itemLabel="court record" headerActions={actions}
          onBack={() => void closeDraft()} onRename={(title) => void renameDraft(title)}
          onDuplicate={() => void duplicateDraft()} onDelete={() => void deleteDraft()} />
          : <WorkspaceHeader className="max-sm:[&_h1]:text-xl" title="Court Records"
            headerActions={actions} />}
      {!draft ? <WorkspaceElement id="court-record-workspace" tabIndex={-1}
        aria-busy={draftBusy} inert={draftBusy}
        className="mx-auto min-h-80 max-w-[50rem] px-4 py-4 outline-none sm:px-6">
        {draftBusy && initialDraftId ? <p className="text-sm text-gray-600" role="status">
          Opening court record
        </p> : <div className="rounded-xl border border-gray-200 bg-white p-6 sm:p-8">
          <h2 className="text-lg font-medium text-gray-900">Prepare a court record</h2>
          <p className="mt-2 max-w-lg text-sm leading-6 text-gray-600">Choose a document format, add your files, and prepare the record for filing.</p>
          <div className="mt-5 flex flex-wrap gap-2">
          <Button disabled={draftBusy} onClick={() => setCreating(true)}>New court record</Button>
          <Button variant="outline" disabled={draftBusy || draftsLoading}
            onClick={() => setSavedOpen(true)}>Open saved record</Button>
          </div>
          {(error || progress || draftBusy) && <p className={cn("inline-flex min-h-10 items-center text-sm",
            error ? "text-red-700" : "text-gray-600")} role={error ? "alert" : "status"}>
            {error || progress || (initialDraftId ? "Opening court record" : "Loading court records")}
          </p>}
        </div>}
      </WorkspaceElement> : <div inert={locked} aria-busy={locked || undefined}
        className={cn("mx-auto grid grid-cols-[minmax(0,1fr)] items-start gap-5 px-4 py-5 sm:px-6",
          compactLayout ? "w-full max-w-[48rem]" : "court-record-layout max-w-[70rem]")}>
        <WorkspaceElement id="court-record-workspace" tabIndex={-1}
          aria-busy={operationBusy || locked} inert={operationBusy || locked}
          className="min-w-0 space-y-4 outline-none">
          {!awaitingSource && <CourtRecordChooser profile={profile} onProfile={chooseProfile}
            jurisdictionOrder={jurisdictionOrder} />}
          {initialKind ? <>
            {documents(`Add the ${initialKind.label.toLowerCase()}`, [initialKind.id], true, 1)}
            {!awaitingSource && <>
              {hasCaseDetails && setup(2)}
              {!!remainingKinds.length && documents(isAffidavit ? "Exhibits" : "Documents",
                remainingKinds, false, hasCaseDetails ? 3 : 2)}
            </>}
          </> : <>
            {hasCaseDetails && setup(1)}
            {documents("Documents", undefined, true, hasCaseDetails ? 2 : 1)}
          </>}
          {awaitingSource && (error || progress || restoredEmpty) && <p role={error ? "alert" : "status"}
            className={cn("text-sm", error ? "text-red-700" : "text-gray-600")}>{error || progress || "This saved record has no files yet — add them below."}</p>}
        </WorkspaceElement>
        {!awaitingSource && <CourtRecordBuildPanel
          profile={profile}
          cover={cover}
          entries={entries}
          report={report}
          result={result}
          building={building}
          saving={saving}
          disabled={operationBusy || locked}
          progress={progress}
          error={error}
          hostMode={host.mode}
          onBuild={() => void build()}
          onDownload={(artifact) => void download(artifact)}
          onSave={host.saveArtifacts ? () => void save() : undefined}
        />}
      </div>}
      {creating && <CourtRecordChooser creating profile={profile}
        jurisdictionOrder={jurisdictionOrder}
        onProfile={(id) => void newDraft(id)}
        onCancel={() => {
          setCreating(false);
          pendingDocuments.current = undefined;
          onDocumentsConsumed?.();
        }} />}
      {savedOpen && <SavedRecordsModal drafts={drafts}
        onOpen={(next) => { setSavedOpen(false); void openSavedDraft(next); }}
        onClose={() => setSavedOpen(false)} />}
      {draft && sourceKindId && sourceKind && (
        <Suspense fallback={null}><AddDocumentsModal open
          breadcrumb={["Court Records", `Choose ${sourceKind.label.toLowerCase()}`]}
          key={`${draft.id}:${draft.projectId}:${profile.id}:${sourceKindId}`}
          accept={sourceAccept(sourceKind)}
          multiple={!!sourceKind.repeatable && !sourceExhibitLabel && !sourceEntryId}
          showTabs={host.mode === "beaver"}
          documents={sourceOutputs.map(({ document }) => document)}
          busy={importingSource}
          onUploadFiles={host.mode === "standalone" ? async (files) => {
            setSourceKindId(undefined);
            await addFiles(sourceKind.id, files, sourceExhibitLabel, sourceEntryId);
          } : undefined}
          onSelect={async (documents) => {
            for (const document of documents) await importSource({ ...document,
              draft: sourceOutputs.find((choice) => choice.document.id === document.id) });
          }}
          onClose={() => { setSourceKindId(undefined); setSourceExhibitLabel(undefined); }}
        /></Suspense>
      )}
      {host.outputFolder && <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)}
        size="lg" breadcrumbs={["Settings"]}>
        <OutputFolderSetting port={host.outputFolder} busy={operationBusy} />
      </Modal>}
    </div>
  );
}

function findingsByEntry(findings: ComplianceFinding[]) {
  const grouped = new Map<string, ComplianceFinding[]>();
  for (const finding of findings) {
    if (!finding.entryId) continue;
    grouped.set(finding.entryId, [...(grouped.get(finding.entryId) ?? []), finding]);
  }
  return grouped;
}

function focusFinding(finding?: ComplianceFinding) {
  if (!finding) return;
  let target: HTMLElement | null = null;
  if (finding.fieldId === "partyContacts") {
    const contact = [...document.querySelectorAll<HTMLElement>("[data-contact-finding-id]")]
      .find((item) => item.dataset.contactFindingId === finding.id);
    target = contact?.querySelector<HTMLElement>("[aria-invalid=true], input, textarea") ?? null;
  } else if (finding.fieldId === "partyGroups") {
    target = document.querySelector(`[data-party-group-id="${finding.id.slice(6)}"] textarea`);
  } else if (finding.fieldId) {
    target = document.getElementById(`cover-${finding.fieldId}`);
  } else if (finding.entryId) {
    const suffix = finding.id.startsWith("date-") ? "date"
      : finding.id.startsWith("exhibit-slot-") ? "exhibit"
        : finding.id.startsWith("searchability-") || finding.id.startsWith("textless-pages-")
          ? "ocr"
          : finding.id.startsWith("description-") || finding.id.startsWith("unknown-")
            ? "title"
            : finding.id.startsWith("missing-file-") ? "relink" : "title";
    target = document.getElementById(`entry-${finding.entryId}-${suffix}`) ||
      document.getElementById(`entry-${finding.entryId}-title`);
  } else if (finding.id.startsWith("missing-")) {
    target = document.getElementById(`court-record-${finding.id.slice(8)}-file`);
  }
  target ??= document.querySelector<HTMLElement>("[data-kind-id] button");
  target?.focus();
}

const sourceKindMayFillCover = (kindId: string) => !/(?:authority|exhibit)/u.test(kindId);
const coverSourceFields = (entries: Array<{ kindId: string;
  sourceFields?: SourceDocumentFields }>) => entries.flatMap((entry) =>
  propagatingSourceFields(entry) ? [entry.sourceFields!] : []);

function fillSourceCover(profile: CourtProfile, current: CoverValues,
  sources: SourceDocumentFields[], previous: SourceDocumentFields[] = []): CoverValues {
  if (!sources.length && !previous.length) return current;
  const allowedFields = new Set(profile.cover.fields.flatMap(({ id }) =>
    profile.cover.template === "abca-ap5" && id === "recordTitle" ? [] : [id]));
  const cover = { ...current };
  for (const id of allowedFields) {
    const next = sourceCoverValue(sources, id), prior = sourceCoverValue(previous, id);
    if (!cover[id]?.trim() || prior && cover[id] === prior) {
      if (next) cover[id] = next;
      else if (prior) delete cover[id];
    }
  }
  return cover;
}

const sourceCoverValue = (sources: SourceDocumentFields[], id: CoverFieldId) =>
  sources.map(({ cover }) => (cover as Partial<Record<CoverFieldId, string>>)[id])
    .find((value) => value?.trim());

function fillExhibitLabels(entries: RecordEntry[]) {
  const labels = sourceExhibitSlots(entries)?.labels ?? [];
  const allowed = new Set(labels), used = new Set<string>();
  return entries.map((entry) => {
    if (entry.kindId !== "exhibit") return entry;
    const current = entry.exhibitLabel?.trim().toUpperCase();
    if (current && allowed.has(current) && !used.has(current)) {
      used.add(current); return current === entry.exhibitLabel ? entry : { ...entry, exhibitLabel: current };
    }
    return current ? { ...entry, exhibitLabel: undefined } : entry;
  });
}

function assignExhibit(entries: RecordEntry[], id: string, label?: string) {
  const dragged = entries.find((entry) => entry.id === id);
  if (!dragged || dragged.kindId !== "exhibit") return entries;
  const nextLabel = label?.trim().toUpperCase() || undefined;
  const slots = sourceExhibitSlots(entries)?.labels ?? [];
  if (nextLabel && !slots.includes(nextLabel)) return entries;
  const previous = dragged.exhibitLabel;
  return entries.map((entry) => entry.id === id ? { ...entry, exhibitLabel: nextLabel }
    : nextLabel && entry.kindId === "exhibit" && entry.exhibitLabel?.toUpperCase() === nextLabel
      ? { ...entry, exhibitLabel: previous }
      : entry);
}

const assignPreparedExhibit = (entries: RecordEntry[], id: string, label?: string) =>
  fillExhibitLabels(label ? assignExhibit(entries, id, label) : entries);

function replacementEntry(entries: RecordEntry[], kind: DocumentKind, label?: string, id?: string) {
  if (id) return entries.find((entry) => entry.id === id && entry.kindId === kind.id);
  const exhibitLabel = label?.trim().toUpperCase();
  return exhibitLabel
    ? entries.find((entry) => entry.kindId === "exhibit" &&
      entry.exhibitLabel?.trim().toUpperCase() === exhibitLabel)
    : kind.repeatable ? undefined : entries.find((entry) => entry.kindId === kind.id);
}

function putPreparedEntry(entries: RecordEntry[], entry: RecordEntry, label?: string) {
  const next = entries.some(({ id }) => id === entry.id)
    ? entries.map((current) => current.id === entry.id ? entry : current)
    : [...entries, entry];
  return assignPreparedExhibit(next, entry.id,
    label ?? entry.sourceFields?.explicitExhibitLabel);
}

function sameState(left: CourtRecordDraft, right: CourtRecordDraft) {
  return JSON.stringify([left.profileId, left.cover, left.entries, left.bindings]) ===
    JSON.stringify([right.profileId, right.cover, right.entries, right.bindings]);
}

function SavedRecordsModal({ drafts, onOpen, onClose }: {
  drafts: WorkProductMetadata[];
  onOpen: (draft: WorkProductMetadata) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [requestedPage, setPage] = useState(1);
  const needle = query.trim().toLowerCase();
  const filtered = drafts.filter((item) => item.title.toLowerCase().includes(needle));
  const pages = Math.max(1, Math.ceil(filtered.length / 8));
  const page = Math.min(requestedPage, pages);
  return <Modal open onClose={onClose} breadcrumbs={["Open saved record"]} size="lg">
    <SearchBar aria-label="Search saved records" placeholder="Search saved records"
      value={query} onValueChange={(value) => { setQuery(value); setPage(1); }} />
    <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
      {filtered.slice((page - 1) * 8, page * 8).map((item) => <button
        key={item.id} type="button" onClick={() => onOpen(item)}
        className="flex min-h-11 w-full items-center gap-3 border-b border-gray-100 px-3 py-2 text-left text-sm outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600">
        <span className="min-w-0 flex-1 truncate font-medium text-gray-950" title={item.title}>{item.title}</span>{" "}
        <time dateTime={item.updatedAt} className="shrink-0 text-xs tabular-nums text-gray-500"
          title="Last updated">{formatDateTime(item.updatedAt)}</time>
      </button>)}
      {!filtered.length && <p role="status" className="px-3 py-6 text-center text-sm text-gray-600">
        {needle ? "No matching records." : "No saved court records yet."}
      </p>}
    </div>
    <Pagination page={page} pages={pages} label="Saved records" onPage={setPage} />
  </Modal>;
}
