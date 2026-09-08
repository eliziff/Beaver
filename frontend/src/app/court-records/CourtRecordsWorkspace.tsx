import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import { Settings2 } from "lucide-react";
import type { Document } from "@/app/lib/api/documents";
import { cn } from "@/app/lib/utils";
import { CourtRecordBuildPanel } from "./CourtRecordBuildPanel";
import { CourtRecordDocuments, type OcrRun } from "./CourtRecordDocuments";
import { buildCourtRecord } from "./assembly";
import { WorkspaceHeader } from "@/app/components/shared/WorkspaceHeader";
import { Button } from "@/app/components/ui/button";
import { AddDocumentsModal } from "@/app/components/modals/AddDocumentsModal";
import { Pagination } from "@/app/components/shared/TablePrimitive";
import { SearchBar } from "@/app/components/ui/search-bar";
import { Modal } from "@/app/components/modals/Modal";
import { OutputFolderSetting } from "@/app/components/shared/OutputFolderSetting";
import { applySourceEntryFields, courtRecordDraft, courtRecordDraftFromDocuments, restoreCourtRecordDraft } from "./draftState";
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
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE_ID);
  const [cover, setCover] = useState<CoverValues>({});
  const [entries, setEntries] = useState<RecordEntry[]>([]);
  const [drafts, setDrafts] = useState<WorkProductMetadata[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draft, setDraft] = useState<WorkProduct<CourtRecordDraft>>();
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
  const [sourceExhibitLabel, setSourceExhibitLabel] = useState<string>();
  const [importingSource, setImportingSource] = useState(false);
  const refreshSeen = useRef(0);
  const openRequest = useRef(0);
  const routeLoading = useRef(false);
  const openingRevision = useRef<{ id: string; revision: number } | undefined>(undefined);
  const draftRef = useRef(draft);
  const stateRef = useRef<CourtRecordDraft>(undefined!);
  const mounted = useRef(true);
  stateRef.current ||= courtRecordDraft(profileId, cover, entries);
  const savingDraft = useRef<Promise<WorkProduct<CourtRecordDraft> | undefined> | undefined>(undefined);
  const stateVersion = useRef(0);
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
    if (!host.runOcr || draftBusy || busyEntryId || importingSource || reading) return;
    const next = entries.find((entry) => entry.inputStatus !== "missing" &&
      sourceFormat(entry.file) === "pdf" && needsOcr(entry));
    if (next) void readEntryEffect(next);
  }, [host, entries, draftBusy, busyEntryId, importingSource, reading]);

  draftRef.current = draft;
  stateRef.current = courtRecordDraft(profileId, cover, entries);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void saveDraftEffect();
    };
  }, []);

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
    if (initialDraftId && initialDraftId === draftRef.current?.id &&
        (draftRef.current.projectId ?? "") === (projectId ?? "")) return;
    let cancelled = false;
    routeLoading.current = !!initialDraftId || !!draftRef.current;
    setDraftBusy(routeLoading.current);
    void (async () => {
      if (draftRef.current && !await saveDraftEffect()) return;
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
        if (projectId && draftRef.current?.projectId !== projectId) clearDraftEffect();
        setError(errorMessage(caught, "Drafts could not be opened."));
      }
    }).finally(() => { if (!cancelled) {
      routeLoading.current = false;
      setDraftBusy(false);
    } });
    return () => { cancelled = true; openRequest.current += 1; };
  }, [host, initialDraftId, projectId]);

  useEffect(() => {
    if (!initialDraftId && initialDocuments?.length) {
      pendingDocuments.current = initialDocuments;
      if (!routeLoading.current) setCreating(true);
    }
  }, [initialDraftId, initialDocuments]);

  useEffect(() => {
    onDraftChange?.(draft, !routeLoading.current && draft === draftRef.current &&
      !operationBusy && (!draft || sameState(draft.state, stateRef.current)));
  }, [draft, operationBusy, profileId, cover, entries, onDraftChange]);

  useEffect(() => {
    if (!draft?.id || refreshToken?.id !== draft.id ||
        refreshToken.sequence <= refreshSeen.current) return;
    refreshSeen.current = refreshToken.sequence;
    void refreshDraftEffect(refreshToken.revision);
  }, [draft?.id, refreshToken]);

  useEffect(() => {
    if (!draft || draftBusy || building || saving || operationBusy && !reading ||
        sameState(draft.state, stateRef.current)) return;
    const timer = window.setTimeout(() => void saveDraftEffect(), 400);
    return () => window.clearTimeout(timer);
  }, [draft, operationBusy, reading, profileId, cover, entries]);

  const report = useMemo(() => validateCourtRecord({
    profile,
    entries,
    cover,
  }), [profile, entries, cover]);
  const missingFields = useMemo(() => new Set(showErrors ? report.blockers.flatMap((item) => item.fieldId ? [item.fieldId] : []) : []), [report.blockers, showErrors]);
  const entryFindings = useMemo(() => findingsByEntry([...report.blockers, ...report.review]), [report]);

  function invalidate() {
    stateVersion.current += 1;
    setResult(undefined);
    setError(undefined);
  }

  function rememberDraft(next: WorkProduct<CourtRecordDraft>) {
    draftRef.current = next;
    if (!mounted.current) return;
    setDraft(next);
    if (projectId && next.projectId !== projectId) return;
    const { state, ...metadata } = next;
    setDrafts((current) => [{ ...metadata, profileId: state.profileId },
      ...current.filter((item) => item.id !== next.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  function clearDraft() {
    stateVersion.current += 1;
    openRequest.current += 1;
    openingRevision.current = undefined;
    draftRef.current = undefined;
    setDraft(undefined);
    setProfileId(DEFAULT_PROFILE_ID);
    setCover({}); setEntries([]);
    setResult(undefined); setShowErrors(false);
    setCreating(false); setSavedOpen(false);
    setSourceKindId(undefined); setSourceExhibitLabel(undefined);
    setReading(undefined);
    setError(undefined); setProgress(undefined); setRestoredEmpty(false);
  }

  function saveCurrentDraft(): Promise<WorkProduct<CourtRecordDraft> | undefined> {
    if (savingDraft.current) return savingDraft.current.then(() => saveCurrentDraft());
    const current = draftRef.current;
    const state = stateRef.current;
    if (!current || sameState(current.state, state)) return Promise.resolve(current);
    const operation = Promise.resolve(host.drafts.update<CourtRecordDraft>(current.id, {
      revision: current.revision,
      state,
    })).then((saved) => {
      if (!saved) return;
      rememberDraft(saved);
      return saved;
    }).catch((caught) => {
      if (mounted.current) setError(errorMessage(caught, "This draft could not be saved."));
      return undefined;
    });
    savingDraft.current = operation;
    void operation.finally(() => {
      if (savingDraft.current === operation) savingDraft.current = undefined;
    });
    return operation;
  }

  async function openDraft(next: WorkProduct<CourtRecordDraft>, wasNew = false) {
    if (projectId && next.projectId !== projectId) {
      throw new Error("This Court Record draft is not in this project.");
    }
    const opening = openingRevision.current;
    if (opening?.id === next.id && opening.revision > next.revision) return;
    openingRevision.current = { id: next.id, revision: next.revision };
    const request = ++openRequest.current;
    setDraftBusy(true);
    setError(undefined);
    setReading(undefined);
    setProgress("Opening draft");
    try {
      const definition = COURT_PROFILE_BY_ID.get(next.state.profileId);
      if (!definition) throw new Error("This filing format is not available.");
      const restored = await restoreCourtRecordDraft(next, host, (message) => {
        if (request === openRequest.current) setProgress(message);
      },
        draftRef.current?.id === next.id ? entries : []);
      if (request !== openRequest.current) return;
      stateVersion.current += 1;
      setProfileId(definition.id);
      const restoredCover = next.state.cover ?? {};
      setCover(fillSourceCover(definition, restoredCover,
        coverSourceFields(restored), coverSourceFields(next.state.entries)));
      setEntries(fillExhibitLabels(restored));
      setResult(undefined);
      setShowErrors(false);
      setCreating(false);
      setRestoredEmpty(!wasNew && next.state.entries.length === 0); rememberDraft(next);
    } catch (caught) {
      if (request === openRequest.current) {
        setError(errorMessage(caught, "This draft could not be opened."));
      }
    } finally {
      if (request === openRequest.current) {
        setProgress(undefined);
        setDraftBusy(false);
      }
    }
  }

  async function refreshDraft(expectedRevision = 0) {
    const current = draftRef.current;
    if (!current || current.revision >= expectedRevision) return;
    try {
      const latest = await host.drafts.get<CourtRecordDraft>(current.id);
      const active = draftRef.current;
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
      rememberDraft(await host.drafts.update(current.id, { revision: current.revision, title }));
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
    const request = openRequest.current;
    setReading({ id: entry.id });
    let patch: Partial<RecordEntry>;
    try {
      patch = await host.runOcr(entry, (message) => {
        if (request === openRequest.current) setReading({ id: entry.id, message });
      });
    } catch {
      patch = { ocrAttemptedPages: [] };
    }
    if (request !== openRequest.current || !mounted.current) return;
    const ready = applySourceEntryFields({ ...entry, ...patch }, undefined, entry.sourceFields);
    setEntries((current) => putPreparedEntry(current, ready, entry.exhibitLabel));
    applySourceCover(ready);
    setReading(undefined);
  }

  function chooseProfile(nextId: string) {
    const next = COURT_PROFILE_BY_ID.get(nextId);
    if (!next) return;
    if (next.id === profileId) { setCreating(false); return; }
    const sourceFields = coverSourceFields(entries);
    setCover((current) => {
      const fields = new Set<string>(next.cover.fields.map(({ id }) => id));
      const kept = Object.fromEntries(Object.entries(current)
        .filter(([field]) => fields.has(field))) as CoverValues;
      const styleId = current.partyStyleId;
      const styles = next.cover.partyStyles;
      const style = styles?.find(({ id }) => id === styleId) ??
        (styles?.length === 1 ? styles[0] : undefined);
      if (!style) return fillSourceCover(next, kept, sourceFields);
      const groups = current.partyGroups?.flatMap((group) => {
        const definition = style.groups.find(({ id }) => id === group.id);
        return definition ? [{ ...group, role: definition.role,
          roleBelow: definition.roleBelow }] : [];
      });
      const eligible = new Set(groups?.filter((group) => !next.cover.filingGroupId ||
        group.id === next.cover.filingGroupId).flatMap((group) => group.parties.map(({ id }) => id)));
      const retainedFilers = current.filingPartyIds?.filter((id) => eligible.has(id));
      const filingPartyIds = retainedFilers?.length ? retainedFilers
        : next.cover.filingGroupId ? [...eligible] : undefined;
      return fillSourceCover(next,
        { ...kept, partyStyleId: style.id, partyGroups: groups, filingPartyIds }, sourceFields);
    });
    setProfileId(next.id);
    const oldKinds = new Set(profile.documentKinds.map(({ id }) => id));
    const nextKinds = new Set(next.documentKinds.map(({ id }) => id));
    const noteKinds = next.documentKinds.filter(({ descriptionOnly, requirement }) =>
      descriptionOnly && requirement !== "forbidden");
    setEntries((current) => fillExhibitLabels(current.map((entry) =>
      !oldKinds.has(entry.kindId) || nextKinds.has(entry.kindId) ? entry : {
        ...entry, kindId: entry.descriptionOnly
          ? noteKinds.length === 1 ? noteKinds[0].id : entry.kindId
          : "other-document",
        exhibitLabel: undefined,
      })));
    setShowErrors(false);
    setCreating(false);
    invalidate();
  }

  function assignKind(id: string, kindId: string) {
    const kind = profile.documentKinds.find((item) => item.id === kindId &&
      item.requirement !== "forbidden" && !item.generated && !item.descriptionOnly);
    if (!kind) return;
    const assigned = entries.find((entry) => entry.id === id);
    setEntries((current) => fillExhibitLabels(current.map((entry) => {
      if (entry.id !== id) return entry;
      return applySourceEntryFields({ ...entry, kindId });
    })));
    if (assigned) {
      applySourceCover(applySourceEntryFields({ ...assigned, kindId }));
    }
    invalidate();
  }

  async function addFiles(kindId: string, files: File[], exhibitLabel?: string) {
    return addSelectedFiles(kindId, files.map((file) => ({ file })), exhibitLabel);
  }

  async function addSelectedFiles(kindId: string, files: SelectedFile[], exhibitLabel?: string) {
    const kind = profile.documentKinds.find((item) => item.id === kindId);
    if (!kind || kind.requirement === "forbidden" || !files.length) return;
    const selected = kind.repeatable && !exhibitLabel ? files : files.slice(0, 1);
    for (const selection of selected) {
      const { file } = selection;
      const previous = replacementEntry(entries, kind, exhibitLabel);
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
      setEntries((current) => current.some((entry) => entry.id === id)
        ? current.map((entry) => entry.id === id ? pending : entry)
        : [...current, pending]);
      setBusyEntryId(id);
      setProgress(`Preparing ${file.name}`);
      invalidate();
      try {
        const prepared = await host.prepareDeviceFile(file, (message) => setProgress(message),
          { workProductId: draftRef.current?.id, destination: kind });
        const ready = applySourceEntryFields({ ...pending, ...prepared,
          binding: prepared.binding ?? selection.input }, previous ? undefined : pending.title,
        previous?.sourceFields);
        setEntries((current) => putPreparedEntry(current, ready, exhibitLabel));
        applySourceCover(ready);
      } catch (caught) {
        setEntries((current) => current.map((entry) => entry.id === id
          ? previous ?? { ...entry,
            inspectionError: errorMessage(caught, "The PDF could not be prepared.") }
          : entry));
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
    setEntries((current) => [...current, {
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
    }]);
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
        (message) => setProgress(message), { workProductId: draftRef.current?.id,
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
      setEntries((current) => fillExhibitLabels(current.map((item) =>
        item.id === id ? ready : item)));
      applySourceCover(ready);
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
        (message) => setProgress(message), { workProductId: draftRef.current?.id, destination });
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
    const version = stateVersion.current;
    try {
      const buildEntries = fillExhibitLabels(await currentInputs(entries));
      const buildCover = fillSourceCover(profile, cover, coverSourceFields(buildEntries),
        coverSourceFields(entries));
      setEntries(buildEntries);
      setCover(buildCover);
      const buildReport = validateCourtRecord({ profile, entries: buildEntries, cover: buildCover });
      if (!buildReport.ready) {
        setShowErrors(true);
        requestAnimationFrame(() => focusFinding(buildReport.blockers[0]));
        throw new Error(buildReport.blockers[0]?.title ?? "Complete the required information.");
      }
      const built = await buildCourtRecord({
        profile,
        entries: buildEntries,
        cover: buildCover,
        preparationDate: new Date().toLocaleDateString("en-CA"),
        needsAttention: buildReport.review.map(({ title, detail }) => ({ title, detail })),
        onProgress: (message, completed, total) => setProgress(`${message} · ${completed}/${total}`),
      });
      if (version !== stateVersion.current) {
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
    setEntries(current);
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
      rememberDraft(saved.product);
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
  async function openSource(kindId: string, exhibitLabel?: string) {
    setSourceOutputs([]);
    setSourceKindId(kindId);
    setSourceExhibitLabel(exhibitLabel);
    const current = draftRef.current;
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
      const previous = replacementEntry(entries, kind, exhibitLabel);
      const entry: RecordEntry = {
        id: previous?.id ?? crypto.randomUUID(),
        kindId,
        title: previous?.title ?? "",
        ...(previous?.date ? { date: previous.date } : {}),
        ...(previous?.sourceExhibits ? { sourceExhibits: previous.sourceExhibits } : {}),
        ...prepared,
      };
      const ready = applySourceEntryFields(entry,
        previous ? undefined : entry.title, previous?.sourceFields);
      setEntries((current) => putPreparedEntry(current, ready, exhibitLabel));
      applySourceCover(ready);
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

  function applySourceCover(entry?: RecordEntry) {
    if (!entry || !propagatingSourceFields(entry)) return;
    const previous = coverSourceFields(entries);
    const sources = [...coverSourceFields(entries.filter(({ id }) => id !== entry.id)),
      entry.sourceFields!];
    setCover((current) => fillSourceCover(profile, current, sources, previous));
    invalidate();
  }
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
      onChoose={(kindId, exhibitLabel) => void openSource(kindId, exhibitLabel)}
      onEntry={(id, patch) => { setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry)); invalidate(); }}
      onAssign={(id, label) => { setEntries((current) => assignExhibit(current, id, label)); invalidate(); }}
      onAddExhibit={() => {
        const slots = sourceExhibitSlots(entries);
        const affidavit = entries.find((entry) => entry.kindId === "affidavit");
        if (!slots || !affidavit || slots.labels.length >= 702) return;
        setEntries((current) => current.map((entry) => entry.id === affidavit.id ? {
          ...entry, sourceExhibits: { sourceSha256: slots.sourceSha256,
            labels: [...slots.labels, exhibitName(slots.labels.length)] },
        } : entry));
        invalidate();
      }}
      onAssignKind={assignKind}
      onRemove={(id) => { setEntries((current) =>
        fillExhibitLabels(current.filter((entry) => entry.id !== id))); invalidate(); }}
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
      setCover((current) => field === "partyStyleId" && typeof value === "string"
        ? fillSourceCover(profile, { ...current, [field]: value }, coverSourceFields(entries))
        : { ...current, [field]: value });
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
        <AddDocumentsModal open
          breadcrumb={["Court Records", `Choose ${sourceKind.label.toLowerCase()}`]}
          key={`${draft.id}:${draft.projectId}:${profile.id}:${sourceKindId}`}
          accept={sourceAccept(sourceKind)}
          multiple={false}
          showTabs={host.mode === "beaver"}
          documents={sourceOutputs.map(({ document }) => document)}
          busy={importingSource}
          onUploadFiles={host.mode === "standalone" ? async (files) => {
            setSourceKindId(undefined);
            await addFiles(sourceKind.id, files, sourceExhibitLabel);
          } : undefined}
          onSelect={async ([document]) => {
            if (document) await importSource({ ...document,
              draft: sourceOutputs.find((choice) => choice.document.id === document.id) });
          }}
          onClose={() => { setSourceKindId(undefined); setSourceExhibitLabel(undefined); }}
        />
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
    target = document.querySelector(`[data-party-group-id="${finding.id.slice(6)}"] input`);
  } else if (finding.fieldId) {
    target = document.getElementById(`cover-${finding.fieldId}`);
  } else if (finding.entryId) {
    const suffix = finding.id.startsWith("date-") ? "date"
      : finding.id.startsWith("exhibit-slot-") ? "exhibit"
        : finding.id.startsWith("searchability-") || finding.id.startsWith("textless-pages-")
          ? "ocr"
          : finding.id.startsWith("description-") || finding.id.startsWith("unknown-")
            ? "title"
            : finding.id.startsWith("missing-file-") ? "relink" : "remove";
    target = document.getElementById(`entry-${finding.entryId}-${suffix}`) ||
      document.getElementById(`entry-${finding.entryId}-remove`);
  } else if (finding.id.startsWith("missing-")) {
    target = document.getElementById(`court-record-${finding.id.slice(8)}-file`);
  }
  target ??= document.querySelector<HTMLElement>("[data-kind-id] input[type=file]");
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

function replacementEntry(entries: RecordEntry[], kind: DocumentKind, label?: string) {
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
