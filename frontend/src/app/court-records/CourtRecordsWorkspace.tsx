import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import type { Document } from "@/app/components/shared/types";
import { cn } from "@/app/lib/utils";
import { CourtRecordBuildPanel } from "./CourtRecordBuildPanel";
import { CourtRecordDocuments } from "./CourtRecordDocuments";
import { DraftHeader } from "@/app/components/shared/DraftHeader";
import { LibraryDocumentPicker } from "@/app/components/shared/LibraryDocumentPicker";
import { SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
import { courtRecordDraft, restoreCourtRecordDraft } from "./draftState";
import { acceptedSourceFormats, sourceFormatLabel } from "./formats";
import { CourtRecordChooser, CourtRecordSetup } from "./CourtRecordSetup";
import { downloadArtifact, needsOcr, type CourtRecordsHost, type DraftOutputChoice,
  type SelectedFile } from "./host";
import { COURT_PROFILE_BY_ID, effectiveCourtProfiles } from "./profiles";
import type { WorkProduct } from "@/app/lib/workProducts";
import type {
  BuildResult,
  BuildArtifact,
  ComplianceFinding,
  CourtRecordDraft,
  CoverValues,
  CourtProfile,
  RecordEntry,
  SourceDocumentFields,
} from "./types";
import { staleBuildSource, validateCourtRecord } from "./validation";

const DEFAULT_PROFILE_ID = "general-affidavit-exhibits";
let assembly: Promise<typeof import("./assembly")> | undefined;
const loadAssembly = () => assembly ??= import("./assembly");

export function CourtRecordsWorkspace({ host, headerActions, onDraftChange, refreshToken,
  initialDraftId, locked = false }: {
  host: CourtRecordsHost;
  headerActions?: ReactNode;
  onDraftChange?: (draft: WorkProduct<CourtRecordDraft> | undefined, synced: boolean) => void;
  refreshToken?: number;
  initialDraftId?: string;
  locked?: boolean;
}) {
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE_ID);
  const [cover, setCover] = useState<CoverValues>({});
  const [entries, setEntries] = useState<RecordEntry[]>([]);
  const [drafts, setDrafts] = useState<WorkProduct<CourtRecordDraft>[]>([]);
  const [draft, setDraft] = useState<WorkProduct<CourtRecordDraft>>();
  const [draftBusy, setDraftBusy] = useState(true);
  const [creating, setCreating] = useState(false);
  const [savedOpen, setSavedOpen] = useState(false);
  const [busyEntryId, setBusyEntryId] = useState<string>();
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [result, setResult] = useState<BuildResult>();
  const [sourceKindId, setSourceKindId] = useState<string>();
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceResults, setSourceResults] = useState<Array<{
    document: Document; draft?: DraftOutputChoice;
  }>>([]);
  const [sourceBusy, setSourceBusy] = useState(false);
  const sourceSearchId = useRef(0);
  const refreshSeen = useRef(refreshToken);
  const openRequest = useRef(0);
  const openingRevision = useRef<{ id: string; revision: number } | undefined>(undefined);
  const draftRef = useRef(draft);
  const stateRef = useRef(courtRecordDraft(profileId, cover, entries));
  const savingDraft = useRef<Promise<WorkProduct<CourtRecordDraft> | undefined> | undefined>(undefined);
  const profile = COURT_PROFILE_BY_ID.get(profileId) ?? COURT_PROFILE_BY_ID.get(DEFAULT_PROFILE_ID)!;
  const preparationDate = today();
  const isAffidavit = profile.family === "affidavit";
  const hasCaseDetails = !!(profile.cover.fields.length || profile.cover.partyStyles?.length);
  const openDraftEffect = useEffectEvent(openDraft);
  const saveDraftEffect = useEffectEvent(saveCurrentDraft);
  const refreshDraftEffect = useEffectEvent(refreshDraft);
  const clearDraftEffect = useEffectEvent(clearDraft);

  draftRef.current = draft;
  stateRef.current = courtRecordDraft(profile.id, cover, entries);

  useEffect(() => {
    if (initialDraftId && initialDraftId === draftRef.current?.id) return;
    let cancelled = false;
    setDraftBusy(true);
    void (async () => {
      if (draftRef.current && !await saveDraftEffect()) return;
      const saved = await host.drafts.list<CourtRecordDraft>("court-record");
      if (cancelled) return;
      setDrafts(saved);
      if (!initialDraftId) { clearDraftEffect(); return; }
      const requested = saved.find(({ id }) => id === initialDraftId) ??
        await host.drafts.get<CourtRecordDraft>(initialDraftId);
      if (requested.kind !== "court-record") throw new Error("This is not a Court Record draft.");
      if (!cancelled) await openDraftEffect(requested);
    })().catch((caught) => {
      if (!cancelled) setError(errorMessage(caught, "Drafts could not be opened."));
    }).finally(() => { if (!cancelled) setDraftBusy(false); });
    return () => { cancelled = true; openRequest.current += 1; };
  }, [host, initialDraftId]);

  useEffect(() => {
    onDraftChange?.(draft, !draftBusy && (!draft || sameState(draft.state, stateRef.current)));
  }, [draft, draftBusy, profile.id, cover, entries, onDraftChange]);

  useEffect(() => {
    if (refreshToken === undefined || refreshToken <= (refreshSeen.current ?? 0)) return;
    refreshSeen.current = refreshToken;
    void refreshDraftEffect(refreshToken);
  }, [refreshToken]);

  useEffect(() => {
    if (!draft || draftBusy || sameState(draft.state, stateRef.current)) return;
    const timer = window.setTimeout(() => void saveDraftEffect(), 400);
    return () => window.clearTimeout(timer);
  }, [draft, draftBusy, profile.id, cover, entries]);

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

  function rememberDraft(next: WorkProduct<CourtRecordDraft>) {
    draftRef.current = next;
    setDraft(next);
    setDrafts((current) => [next, ...current.filter((item) => item.id !== next.id)]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
  }

  function clearDraft() {
    openRequest.current += 1;
    openingRevision.current = undefined;
    draftRef.current = undefined;
    setDraft(undefined);
    setProfileId(DEFAULT_PROFILE_ID);
    setCover({}); setEntries([]);
    setResult(undefined); setShowErrors(false);
    setCreating(false); setSavedOpen(false);
    setSourceKindId(undefined); setError(undefined); setProgress(undefined);
  }

  function saveCurrentDraft(): Promise<WorkProduct<CourtRecordDraft> | undefined> {
    if (savingDraft.current) return savingDraft.current;
    const current = draftRef.current;
    const state = stateRef.current;
    if (!current || sameState(current.state, state)) return Promise.resolve(current);
    const operation = host.drafts.update<CourtRecordDraft>(current.id, {
      revision: current.revision,
      state,
    }).then((saved) => {
      rememberDraft(saved);
      return saved;
    }).catch((caught) => {
      setError(errorMessage(caught, "This draft could not be saved."));
      return undefined;
    });
    savingDraft.current = operation;
    void operation.finally(() => {
      if (savingDraft.current === operation) savingDraft.current = undefined;
    });
    return operation;
  }

  async function openDraft(next: WorkProduct<CourtRecordDraft>) {
    const opening = openingRevision.current;
    if (opening?.id === next.id && opening.revision > next.revision) return;
    openingRevision.current = { id: next.id, revision: next.revision };
    const request = ++openRequest.current;
    setDraftBusy(true);
    setError(undefined);
    setProgress("Opening draft");
    try {
      const restored = await restoreCourtRecordDraft(next, host, (message) => {
        if (request === openRequest.current) setProgress(message);
      },
        draftRef.current?.id === next.id ? entries : []);
      if (request !== openRequest.current) return;
      const nextProfile = COURT_PROFILE_BY_ID.has(next.state.profileId)
        ? next.state.profileId : DEFAULT_PROFILE_ID;
      setProfileId(nextProfile);
      setCover(fillSourceCover(COURT_PROFILE_BY_ID.get(nextProfile)!, next.state.cover ?? {},
        restored.flatMap((entry) => entry.sourceFields ? [entry.sourceFields] : [])));
      setEntries(fillExhibitLabels(restored));
      setResult(undefined);
      setShowErrors(false);
      rememberDraft(next);
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
    const nextProfile = effectiveCourtProfiles().some(({ id }) => id === nextProfileId)
      ? nextProfileId : DEFAULT_PROFILE_ID;
    setDraftBusy(true);
    try {
      const definition = COURT_PROFILE_BY_ID.get(nextProfile)!;
      const allowed = new Set<string>(definition.cover.fields.map(({ id }) => id));
      const defaults = Object.fromEntries(Object.entries(await host.newDraftCover?.() ?? {})
        .filter(([field]) => allowed.has(field))) as CoverValues;
      const created = await host.drafts.create({ kind: "court-record",
        title: "Untitled court record", state: courtRecordDraft(nextProfile, defaults, []) });
      await openDraft(created);
    } catch (caught) {
      setError(errorMessage(caught, "The court record could not be created."));
      setDraftBusy(false);
    }
  }

  async function openSavedDraft(next: WorkProduct<CourtRecordDraft>) {
    setSavedOpen(false);
    await openDraft(next);
  }

  async function closeDraft() {
    if (!await saveCurrentDraft()) return;
    clearDraft();
  }

  async function duplicateDraft() {
    const current = await saveCurrentDraft();
    if (!current) return;
    const created = await host.drafts.create({
      kind: "court-record",
      title: `${current.title} copy`,
      projectId: current.projectId,
      state: stateRef.current,
    });
    await openDraft(created);
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

  const ocr = (entry: RecordEntry) => host.runOcr?.(entry, (message, completed, total) => {
    setProgress(total ? `${message} · ${completed ?? 0}/${total}` : message);
  });

  function chooseProfile(nextId: string) {
    const next = COURT_PROFILE_BY_ID.get(nextId);
    if (!next || next.id === profile.id) return;
    if (entries.length && !window.confirm("Changing the format will remove the source files in this build.")) return;
    setCover((current) => {
      const fields = new Set<string>(next.cover.fields.map(({ id }) => id));
      const kept = Object.fromEntries(Object.entries(current)
        .filter(([field]) => fields.has(field))) as CoverValues;
      const styleId = current.partyStyleId ?? profile.cover.partyStyles?.[0]?.id;
      const style = next.cover.partyStyles?.find(({ id }) => id === styleId);
      if (!style) return kept;
      const groups = current.partyGroups?.filter(({ id }) =>
        style.groups.some((group) => group.id === id));
      const filingPartyId = current.filingPartyId && groups?.some((group) =>
        (!next.cover.filingGroupId || group.id === next.cover.filingGroupId) &&
        group.parties.some(({ id }) => id === current.filingPartyId))
        ? current.filingPartyId : undefined;
      return { ...kept, partyStyleId: style.id, partyGroups: groups, filingPartyId };
    });
    setProfileId(next.id);
    setEntries([]);
    setShowErrors(false);
    invalidate();
  }

  async function addFiles(kindId: string, files: File[]) {
    return addSelectedFiles(kindId, files.map((file) => ({ file })));
  }

  async function pickFiles(kindId: string) {
    const kind = profile.documentKinds.find((item) => item.id === kindId);
    if (!kind || !host.pickDeviceFiles) return;
    try {
      await addSelectedFiles(kindId, await host.pickDeviceFiles(!!kind.repeatable));
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError")) {
        setError(errorMessage(caught, "The file could not be selected."));
      }
    }
  }

  async function addSelectedFiles(kindId: string, files: SelectedFile[]) {
    const kind = profile.documentKinds.find((item) => item.id === kindId);
    if (!kind || kind.requirement === "forbidden" || !files.length) return;
    const selected = kind.repeatable ? files : files.slice(0, 1);
    for (const selection of selected) {
      const { file } = selection;
      const id = crypto.randomUUID();
      const pending: RecordEntry = {
        id,
        kindId,
        file,
        title: kind.repeatable ? titleFromFile(file.name) : kind.label,
        pageCount: null,
        searchable: null,
        encrypted: null,
        origin: { kind: "device" },
        binding: selection.input,
      };
      setEntries((current) => [...current, pending]);
      setBusyEntryId(id);
      setProgress(`Preparing ${file.name}`);
      invalidate();
      try {
        const prepared = await host.prepareDeviceFile(file, (message) => setProgress(message),
          { workProductId: draftRef.current?.id });
        let ready = sourceEntry({ ...pending, ...prepared,
          binding: prepared.binding ?? selection.input }, pending.title);
        setEntries((current) => fillExhibitLabels(current.map((entry) => entry.id === id ? ready : entry)));
        applySourceCover(ready.sourceFields);
        if (host.runOcr && needsOcr(ready)) {
          try {
            const patch = await ocr(ready);
            if (patch) {
              ready = sourceEntry({ ...ready, ...patch }, pending.title);
              setEntries((current) => fillExhibitLabels(current.map((entry) => entry.id === id ? ready : entry)));
              applySourceCover(ready.sourceFields);
            }
          } catch (caught) {
            setError(errorMessage(caught, "OCR failed."));
          }
        }
      } catch (caught) {
        setEntries((current) => current.map((entry) => entry.id === id ? {
          ...entry,
          inspectionError: errorMessage(caught, "The PDF could not be prepared."),
        } : entry));
      } finally {
        setBusyEntryId(undefined);
        setProgress(undefined);
      }
    }
  }

  function addDescription(kindId: string) {
    const kind = profile.documentKinds.find((item) => item.id === kindId &&
      (item.descriptionOnly || item.allowUnavailableNote));
    if (!kind) return;
    const id = crypto.randomUUID();
    setEntries((current) => [...current, {
      id,
      kindId,
      title: kind.defaultDescription ?? (kind.allowUnavailableNote
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
    requestAnimationFrame(() => document.querySelector<HTMLElement>(
      `[data-entry-id="${id}"] input`,
    )?.focus());
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
        (message) => setProgress(message), { workProductId: draftRef.current?.id });
      setEntries((current) => fillExhibitLabels(current.map((item) => item.id === id ? sourceEntry({
        ...item,
        ...prepared,
        binding: resolved.input,
        inputStatus: resolved.status,
        missingReason: undefined,
        lastSeen: undefined,
      }) : item)));
      applySourceCover(prepared.sourceFields);
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

  async function runOcr(id: string) {
    const entry = entries.find((item) => item.id === id);
    if (!entry || !host.runOcr) return;
    setBusyEntryId(id);
    setError(undefined);
    setResult(undefined);
    try {
      const patch = await ocr(entry);
      if (!patch) return;
      const ready = sourceEntry({ ...entry, ...patch });
      setEntries((current) => fillExhibitLabels(current.map((item) => item.id === id ? ready : item)));
      applySourceCover(ready.sourceFields);
    } catch (caught) {
      setError(errorMessage(caught, "OCR failed."));
    } finally {
      setBusyEntryId(undefined);
      setProgress(undefined);
    }
  }

  async function currentInputs(items: RecordEntry[]) {
    return Promise.all(items.map(async (entry) => {
      if (!entry.binding || entry.descriptionOnly) return entry;
      const resolved = await host.resolveInput(entry.binding, (message) => setProgress(message));
      if (resolved.status === "missing") {
        return { ...entry, inputStatus: "missing" as const, missingReason: resolved.reason };
      }
      const prepared = resolved.prepared ?? await host.prepareDeviceFile(resolved.file,
        (message) => setProgress(message), { workProductId: draftRef.current?.id });
      let next: RecordEntry = sourceEntry({ ...entry, ...prepared, binding: resolved.input,
        inputStatus: resolved.status, missingReason: undefined });
      if (host.runOcr && needsOcr(next)) next = { ...next, ...await ocr(next) };
      return next;
    }));
  }

  async function build() {
    if (building) return;
    if (!report.ready) {
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
      setEntries(buildEntries);
      const buildReport = validateCourtRecord({ profile, entries: buildEntries, cover });
      if (!buildReport.ready) {
        setShowErrors(true);
        requestAnimationFrame(() => focusFinding(buildReport.blockers[0]));
        throw new Error(buildReport.blockers[0]?.title ?? "Complete the required information.");
      }
      const { buildCourtRecord } = await loadAssembly();
      const built = await buildCourtRecord({
        profile,
        entries: buildEntries,
        cover,
        preparationDate,
        needsAttention: buildReport.review.map(({ title, detail }) => ({ title, detail })),
        onProgress: (message, completed, total) => setProgress(`${message} · ${completed}/${total}`),
      });
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
      setProgress(`${result.artifacts.length} file${result.artifacts.length === 1 ? "" : "s"} saved`);
    } catch (caught) {
      setError(errorMessage(caught, "The built files could not be saved."));
    } finally {
      setSaving(false);
    }
  }

  async function searchSources(query: string, kindId = sourceKindId) {
    setSourceQuery(query);
    if (!kindId) return;
    const kind = profile.documentKinds.find((item) => item.id === kindId);
    if (!kind) return;
    const searchId = ++sourceSearchId.current;
    setSourceBusy(true);
    try {
      const formats = acceptedSourceFormats(kind);
      const [library, outputs] = await Promise.all([
        host.searchLibrary?.(query, formats,
          { workProductId: draftRef.current?.id }) ?? [],
        host.searchDraftOutputs?.(query, formats, draftRef.current?.id) ?? [],
      ]);
      const results = new Map<string, { document: Document; draft?: DraftOutputChoice }>(
        library.map((document) => [document.id, { document }]),
      );
      for (const draft of outputs) {
        results.set(draft.document.id, { document: draft.document, draft });
      }
      if (searchId === sourceSearchId.current) setSourceResults([...results.values()]);
    } catch (caught) {
      if (searchId === sourceSearchId.current) {
        setError(errorMessage(caught, "Available files could not be loaded."));
      }
    } finally {
      if (searchId === sourceSearchId.current) setSourceBusy(false);
    }
  }

  function openSource(kindId: string) {
    setSourceKindId(kindId);
    setSourceQuery("");
    setSourceResults([]);
    void searchSources("", kindId);
  }

  async function importSource(document: Document) {
    if (!sourceKindId) return;
    const selected = sourceResults.find((item) => item.document.id === document.id);
    if (!selected) return;
    const kindId = sourceKindId;
    const kind = profile.documentKinds.find((item) => item.id === kindId);
    if (!kind) return;
    setSourceBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const prepared = selected.draft
        ? await host.importDraftOutput!(selected.draft, (message) => setProgress(message))
        : await host.importLibraryDocument!(selected.document, (message) => setProgress(message));
      const entry: RecordEntry = {
        id: crypto.randomUUID(),
        kindId,
        title: kind.repeatable ? titleFromFile(prepared.file.name) : kind.label,
        ...prepared,
      };
      setBusyEntryId(entry.id);
      let patch: Partial<RecordEntry> | undefined;
      if (host.runOcr && needsOcr(entry)) {
        try { patch = await ocr(entry); }
        catch (caught) { setError(errorMessage(caught, "OCR failed.")); }
      }
      const ready = sourceEntry({ ...entry, ...patch }, entry.title);
      setEntries((current) => fillExhibitLabels([...current, ready]));
      applySourceCover(ready.sourceFields);
      setSourceKindId(undefined);
    } catch (caught) {
      setError(errorMessage(caught, "The selected file could not be added."));
    } finally {
      setSourceBusy(false);
      setBusyEntryId(undefined);
      setProgress(undefined);
    }
  }

  const sourceKind = profile.documentKinds.find((item) => item.id === sourceKindId);

  function applySourceCover(fields?: SourceDocumentFields) {
    if (!fields) return;
    setCover((current) => fillSourceCover(profile, current, [fields]));
    invalidate();
  }
  const WorkspaceElement = host.mode === "standalone" ? "main" : "div";
  const documents = (heading: string, kindIds?: string[]) => (
    <CourtRecordDocuments
      profile={profile}
      entries={entries}
      busyEntryId={busyEntryId}
      entryFindings={entryFindings}
      kindIds={kindIds}
      heading={heading}
      onFiles={(kindId, files) => void addFiles(kindId, files)}
      onDescription={addDescription}
      onPick={host.pickDeviceFiles ? (kindId) => void pickFiles(kindId) : undefined}
      onLibrary={host.searchLibrary || host.searchDraftOutputs ? openSource : undefined}
      onEntry={(id, patch) => { setEntries((current) => current.map((entry) => entry.id === id ? { ...entry, ...patch } : entry)); invalidate(); }}
      onMove={(id, beforeId) => { setEntries((current) => moveEntry(current, id, beforeId)); invalidate(); }}
      onAssign={(id, label) => { setEntries((current) => assignExhibit(current, id, label)); invalidate(); }}
      onRemove={(id) => { setEntries((current) => current.filter((entry) => entry.id !== id)); invalidate(); }}
      onOcr={host.runOcr ? (id) => void runOcr(id) : undefined}
      onRelink={host.relinkInput ? (id) => void relinkEntry(id) : undefined}
    />
  );
  const setup = (heading: string) => <CourtRecordSetup
    profile={profile} cover={cover} missingFields={missingFields} heading={heading}
    onCover={(field, value) => {
      setCover((current) => ({ ...current, [field]: value })); invalidate();
    }} />;
  return (
    <div className={cn("court-records-workspace bg-[#f5f5f4]", host.mode === "standalone"
      ? "min-h-dvh"
      : "min-h-full lg:h-full lg:min-h-0 lg:overflow-y-auto")}>
      <a href="#court-record-workspace" className="fixed left-3 top-3 z-50 -translate-y-20 rounded-md bg-white px-3 py-2 text-sm font-semibold text-gray-950 shadow focus:translate-y-0 focus:ring-2 focus:ring-red-600">Skip to builder</a>
      <header className="border-b border-gray-200/80 bg-white/90 backdrop-blur">
        {draft ? <DraftHeader className="max-w-[78rem]" current={draft}
          busy={draftBusy || locked} itemLabel="court record" headerActions={headerActions}
          onBack={() => void closeDraft()} onRename={(title) => void renameDraft(title)}
          onDuplicate={() => void duplicateDraft()} onDelete={() => void deleteDraft()} />
          : <div className="builder-header mx-auto max-w-[78rem] px-4 py-4 sm:px-6">
            <h1 className="font-serif text-2xl font-semibold leading-tight text-gray-950">Court Records</h1>
          </div>}
      </header>
      {!draft ? <WorkspaceElement id="court-record-workspace" tabIndex={-1}
        aria-busy={draftBusy} inert={draftBusy}
        className="mx-auto flex min-h-80 max-w-[78rem] flex-col items-center justify-center px-4 py-12 text-center outline-none sm:px-6">
        <h2 className="font-serif text-2xl font-semibold text-gray-950">Start a court record</h2>
        <p className="mt-2 text-sm text-gray-600">Choose a filing format or open a saved record.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button type="button" disabled={draftBusy} onClick={() => setCreating(true)}
            className="min-h-10 rounded-md bg-gray-950 px-4 text-sm font-medium text-white outline-none hover:bg-gray-800 focus-visible:ring-2 focus-visible:ring-gray-950 focus-visible:ring-offset-2 disabled:opacity-50">
            New court record
          </button>
          {!!drafts.length && <button type="button" disabled={draftBusy}
            onClick={() => setSavedOpen(true)}
            className="min-h-10 rounded-md border border-gray-300 bg-white px-4 text-sm font-medium text-gray-800 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-gray-950 disabled:opacity-50">
            Open saved record
          </button>}
        </div>
        <p className={cn("mt-4 min-h-5 text-sm", error ? "text-red-700" : "text-gray-600")}
          role={error ? "alert" : "status"}>{error || progress || (draftBusy ? "Loading court records" : "")}</p>
      </WorkspaceElement> : <div inert={locked} aria-busy={locked || undefined}
        className="court-record-layout mx-auto grid max-w-[78rem] grid-cols-[minmax(0,1fr)] items-start gap-5 px-4 py-5 sm:px-6">
        <WorkspaceElement id="court-record-workspace" tabIndex={-1}
          aria-busy={draftBusy} inert={draftBusy}
          className="min-w-0 space-y-4 outline-none">
          <section className="px-1 pb-1" aria-labelledby="builder-intro-heading">
            <h2 id="builder-intro-heading" className="text-balance font-serif text-xl font-semibold leading-tight text-gray-950 sm:text-2xl">
              {isAffidavit ? "Build an affidavit with exhibits" : `Build ${profile.label.toLowerCase()}`}
            </h2>
            <p className="mt-1 max-w-2xl text-base leading-6 text-gray-600">
              {isAffidavit ? "Add the affidavit, complete the case details, then add the exhibits in order."
                : hasCaseDetails ? "Add the documents, complete the case details, then review and build the record."
                  : "Add the documents, then review and prepare the filing set."}
            </p>
          </section>
          <CourtRecordChooser profile={profile} onProfile={chooseProfile} />
          {isAffidavit ? <>
            {documents("1. Add the affidavit", ["affidavit"])}
            {setup("2. Case details")}
            {documents("3. Add exhibits or another document", ["exhibit", "other-document"])}
          </> : <>
            {hasCaseDetails && setup("1. Case details")}
            {documents(`${hasCaseDetails ? "2" : "1"}. Add documents`)}
          </>}
        </WorkspaceElement>
        <CourtRecordBuildPanel
          profile={profile}
          cover={cover}
          entries={entries}
          report={report}
          result={result}
          building={building}
          saving={saving}
          progress={progress}
          error={error}
          hostMode={host.mode}
          onBuild={() => void build()}
          onDownload={(artifact) => void download(artifact)}
          onSave={host.saveArtifacts ? () => void save() : undefined}
        />
      </div>}
      {creating && <CourtRecordChooser creating profile={profile}
        onProfile={(id) => void newDraft(id)} onCancel={() => setCreating(false)} />}
      {savedOpen && <SearchableChoiceModal open title="Open saved record"
        searchLabel="Search saved records" searchable={drafts.length > 8}
        value={null} options={drafts.map(({ id, title }) => ({ value: id, label: title }))}
        onChange={(id) => {
          const next = drafts.find((item) => item.id === id);
          if (next) void openSavedDraft(next);
        }} onClose={() => setSavedOpen(false)} />}
      {draft && sourceKindId && sourceKind && (
        <LibraryDocumentPicker
          open
          title={`Add ${sourceKind.label} from Library`}
          formatLabel={sourceFormatLabel(sourceKind)}
          sourceLabel="Library"
          query={sourceQuery}
          results={sourceResults.map(({ document }) => document)}
          busy={sourceBusy}
          detail={(document) => {
            const output = sourceResults.find((item) => item.document.id === document.id)?.draft;
            return output ? `From ${output.workProductTitle}` : undefined;
          }}
          onQuery={(query) => void searchSources(query)}
          onSelect={(document) => void importSource(document)}
          onClose={() => setSourceKindId(undefined)}
        />
      )}
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
  const target = finding?.fieldId
    ? document.getElementById(`cover-${finding.fieldId}`)
    : finding?.id.startsWith("missing-")
      ? document.getElementById(`court-record-${finding.id.slice(8)}-file`)
      : finding?.entryId
        ? document.querySelector<HTMLElement>(`[data-entry-id="${finding.entryId}"] input`)
        : document.querySelector<HTMLElement>("[data-kind-id] input[type=file]");
  target?.focus();
}

function titleFromFile(filename: string) {
  return filename.replace(/\.(?:pdf|docx)$/iu, "").replace(/[_-]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function fillSourceCover(profile: CourtProfile, current: CoverValues,
  sources: SourceDocumentFields[]): CoverValues {
  if (!sources.length) return current;
  const allowed = new Set(profile.cover.fields.map(({ id }) => id));
  const cover = { ...current };
  for (const source of sources) {
    for (const [field, value] of Object.entries(source.cover)) {
      if (allowed.has(field as keyof typeof source.cover) && value &&
        !cover[field as keyof typeof source.cover]?.trim()) {
        cover[field as keyof typeof source.cover] = value;
      }
    }
  }
  const styles = profile.cover.partyStyles;
  const partySources = sources.filter((source) => source.parties);
  if (!styles?.length || !partySources.length) return cover;
  const sourceStyleId = sources.find((source) =>
    styles.some(({ id }) => id === source.partyStyleId))?.partyStyleId;
  const styleId = cover.partyStyleId || sourceStyleId || styles[0].id;
  const style = styles.find(({ id }) => id === styleId)!;
  const groups = style.groups.flatMap((definition, index) => {
    const existing = cover.partyGroups?.find(({ id }) => id === definition.id);
    if (definition.optional && !existing) return [];
    const value = partySources.map((source) => index ? source.parties?.second
      : source.parties?.first).find((name) => name?.trim());
    const parties = existing?.parties?.length ? existing.parties.map((party, partyIndex) =>
      partyIndex === 0 && !party.name.trim() && value ? { ...party, name: value } : party)
      : [{ id: `${definition.id}-1`, name: value ?? "" }];
    return [{ id: definition.id, role: definition.role, roleBelow: definition.roleBelow, parties }];
  });
  return { ...cover, partyStyleId: styleId, partyGroups: groups };
}

function fillExhibitLabels(entries: RecordEntry[]) {
  const labels = entries.find((entry) => entry.kindId === "affidavit")?.sourceFields?.exhibitLabels ?? [];
  const used = new Set(entries.flatMap((entry) => entry.exhibitLabel?.trim()
    ? [entry.exhibitLabel.trim().toUpperCase()] : []));
  return entries.map((entry) => {
    if (entry.kindId !== "exhibit" || entry.exhibitLabel?.trim()) return entry;
    const explicit = entry.sourceFields?.explicitExhibitLabel;
    if (!explicit || !labels.includes(explicit) || used.has(explicit)) return entry;
    used.add(explicit);
    return { ...entry, exhibitLabel: explicit };
  });
}

function sourceEntry(entry: RecordEntry, replaceTitle?: string): RecordEntry {
  const source = entry.sourceFields;
  if (!source) return entry;
  return {
    ...entry,
    title: source.entryTitle && (!entry.title.trim() || entry.title === replaceTitle)
      ? source.entryTitle : entry.title,
    date: entry.date?.trim() ? entry.date : source.entryDate,
  };
}

function assignExhibit(entries: RecordEntry[], id: string, label?: string) {
  const dragged = entries.find((entry) => entry.id === id);
  if (!dragged || dragged.kindId !== "exhibit") return entries;
  const nextLabel = label?.trim().toUpperCase() || undefined;
  const previous = dragged.exhibitLabel;
  return entries.map((entry) => entry.id === id ? { ...entry, exhibitLabel: nextLabel }
    : nextLabel && entry.kindId === "exhibit" && entry.exhibitLabel?.toUpperCase() === nextLabel
      ? { ...entry, exhibitLabel: previous }
      : entry);
}

function moveEntry(entries: RecordEntry[], id: string, beforeId?: string) {
  const from = entries.findIndex((entry) => entry.id === id);
  if (from < 0 || id === beforeId) return entries;
  const next = [...entries], [entry] = next.splice(from, 1);
  const to = beforeId ? next.findIndex((item) => item.id === beforeId) : next.length;
  next.splice(to < 0 ? next.length : to, 0, entry);
  return fillExhibitLabels(next);
}

function today() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function sameState(left: CourtRecordDraft, right: CourtRecordDraft) {
  return JSON.stringify([left.profileId, left.cover, left.entries, left.bindings]) ===
    JSON.stringify([right.profileId, right.cover, right.entries, right.bindings]);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}
