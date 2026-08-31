import { useEffect, useEffectEvent, useMemo, useRef, useState, type ReactNode } from "react";
import type { Document } from "@/app/components/shared/types";
import { cn } from "@/app/lib/utils";
import { CourtRecordBuildPanel } from "./CourtRecordBuildPanel";
import { CourtRecordDocuments } from "./CourtRecordDocuments";
import { DraftMenu } from "@/app/components/shared/DraftMenu";
import { LibraryDocumentPicker } from "@/app/components/shared/LibraryDocumentPicker";
import { courtRecordDraft, restoreCourtRecordDraft } from "./draftState";
import { acceptedSourceFormats, sourceFormatLabel } from "./formats";
import { CourtRecordChooser, CourtRecordSetup } from "./CourtRecordSetup";
import { downloadArtifact, type CourtRecordsHost, type DraftOutputChoice,
  type SelectedFile } from "./host";
import { COURT_PROFILE_BY_ID } from "./profiles";
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
  initialDraftId }: {
  host: CourtRecordsHost;
  headerActions?: ReactNode;
  onDraftChange?: (draft?: WorkProduct<CourtRecordDraft>) => void;
  refreshToken?: number;
  initialDraftId?: string;
}) {
  const [profileId, setProfileId] = useState(DEFAULT_PROFILE_ID);
  const [cover, setCover] = useState<CoverValues>({});
  const [entries, setEntries] = useState<RecordEntry[]>([]);
  const [drafts, setDrafts] = useState<WorkProduct<CourtRecordDraft>[]>([]);
  const [draft, setDraft] = useState<WorkProduct<CourtRecordDraft>>();
  const [draftBusy, setDraftBusy] = useState(true);
  const [busyEntryId, setBusyEntryId] = useState<string>();
  const [progress, setProgress] = useState<string>();
  const [error, setError] = useState<string>();
  const [building, setBuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [result, setResult] = useState<BuildResult>();
  const [sourcePicker, setSourcePicker] = useState<{
    kindId: string; source: "library" | "draft";
  }>();
  const [sourceQuery, setSourceQuery] = useState("");
  const [sourceResults, setSourceResults] = useState<Array<{
    document: Document; draft?: DraftOutputChoice;
  }>>([]);
  const [sourceBusy, setSourceBusy] = useState(false);
  const sourceSearchId = useRef(0);
  const refreshSeen = useRef(refreshToken);
  const draftRef = useRef(draft);
  const stateRef = useRef(courtRecordDraft(profileId, cover, entries));
  const savingDraft = useRef<Promise<WorkProduct<CourtRecordDraft> | undefined> | undefined>(undefined);
  const profile = COURT_PROFILE_BY_ID.get(profileId) ?? COURT_PROFILE_BY_ID.get(DEFAULT_PROFILE_ID)!;
  const preparationDate = today();
  const isAffidavit = profile.family === "affidavit";
  const openDraftEffect = useEffectEvent(openDraft);
  const saveDraftEffect = useEffectEvent(saveCurrentDraft);
  const refreshDraftEffect = useEffectEvent(refreshDraft);

  draftRef.current = draft;
  stateRef.current = courtRecordDraft(profile.id, cover, entries);

  useEffect(() => {
    let cancelled = false;
    void host.drafts.list<CourtRecordDraft>("court-record").then(async (saved) => {
      if (cancelled) return;
      setDrafts(saved);
      const first = saved.find(({ id }) => id === initialDraftId) ?? saved[0] ??
        await host.drafts.create({ kind: "court-record",
        title: "Untitled court record", state: courtRecordDraft(DEFAULT_PROFILE_ID,
          await host.newDraftCover?.() ?? {}, []) });
      if (!cancelled) await openDraftEffect(first);
    }).catch((caught) => {
      if (!cancelled) setError(errorMessage(caught, "Drafts could not be opened."));
    }).finally(() => { if (!cancelled) setDraftBusy(false); });
    return () => { cancelled = true; };
  }, [host, initialDraftId]);

  useEffect(() => { void loadAssembly(); }, []);

  useEffect(() => {
    onDraftChange?.(!draftBusy && draft && sameState(draft.state, stateRef.current)
      ? draft : undefined);
  }, [draft, draftBusy, profile.id, cover, entries, onDraftChange]);

  useEffect(() => {
    if (refreshToken === undefined || refreshToken === refreshSeen.current) return;
    refreshSeen.current = refreshToken;
    void refreshDraftEffect();
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
      return current;
    });
    savingDraft.current = operation;
    void operation.finally(() => {
      if (savingDraft.current === operation) savingDraft.current = undefined;
    });
    return operation;
  }

  async function openDraft(next: WorkProduct<CourtRecordDraft>) {
    setDraftBusy(true);
    setError(undefined);
    setProgress("Opening draft");
    try {
      const restored = await restoreCourtRecordDraft(next, host, (message) => setProgress(message));
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
      setError(errorMessage(caught, "This draft could not be opened."));
    } finally {
      setProgress(undefined);
      setDraftBusy(false);
    }
  }

  async function refreshDraft() {
    const current = draftRef.current;
    if (!current) return;
    try {
      const latest = (await host.drafts.list<CourtRecordDraft>("court-record"))
        .find(({ id }) => id === current.id);
      if (latest) await openDraft(latest);
    } catch (caught) {
      setError(errorMessage(caught, "This draft could not be refreshed."));
    }
  }

  async function newDraft() {
    await saveCurrentDraft();
    const state = courtRecordDraft(DEFAULT_PROFILE_ID,
      await host.newDraftCover?.() ?? {}, []);
    const created = await host.drafts.create({
      kind: "court-record",
      title: "Untitled court record",
      state,
    });
    await openDraft(created);
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
      setDraft(undefined);
      draftRef.current = undefined;
      if (remaining[0]) await openDraft(remaining[0]);
      else await newDraft();
    } catch (caught) {
      setError(errorMessage(caught, "The draft could not be deleted."));
    } finally {
      setDraftBusy(false);
    }
  }

  const needsOcr = (entry: RecordEntry) =>
    entry.searchable === false || (entry.textlessPageCount ?? 0) > 0;
  const ocr = (entry: RecordEntry) => host.runOcr?.(entry, (message, completed, total) => {
    setProgress(total ? `${message} · ${completed ?? 0}/${total}` : message);
  });

  function chooseProfile(nextId: string) {
    if (nextId === profile.id) return;
    if (entries.length && !window.confirm("Changing the format will remove the source files in this build.")) return;
    setProfileId(nextId);
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
    const kind = profile.documentKinds.find((item) => item.id === kindId && item.descriptionOnly);
    if (!kind) return;
    const id = crypto.randomUUID();
    setEntries((current) => [...current, {
      id,
      kindId,
      title: "",
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

  async function searchSources(query: string, picker = sourcePicker) {
    setSourceQuery(query);
    if (!picker) return;
    const kind = profile.documentKinds.find((item) => item.id === picker.kindId);
    if (!kind) return;
    const searchId = ++sourceSearchId.current;
    setSourceBusy(true);
    try {
      const formats = acceptedSourceFormats(kind);
      const results = picker.source === "draft"
        ? (await host.searchDraftOutputs?.(query, formats, draftRef.current?.id) ?? [])
          .map((draft) => ({ document: draft.document, draft }))
        : (await host.searchLibrary?.(query, formats,
          { workProductId: draftRef.current?.id }) ?? [])
          .map((document) => ({ document }));
      if (searchId === sourceSearchId.current) setSourceResults(results);
    } catch (caught) {
      if (searchId === sourceSearchId.current) {
        setError(errorMessage(caught, "Available files could not be loaded."));
      }
    } finally {
      if (searchId === sourceSearchId.current) setSourceBusy(false);
    }
  }

  function openSource(kindId: string, source: "library" | "draft") {
    const picker = { kindId, source } as const;
    setSourcePicker(picker);
    setSourceQuery("");
    setSourceResults([]);
    void searchSources("", picker);
  }

  async function importSource(document: Document) {
    if (!sourcePicker) return;
    const selected = sourceResults.find((item) => item.document.id === document.id);
    if (!selected) return;
    const kindId = sourcePicker.kindId;
    const kind = profile.documentKinds.find((item) => item.id === kindId);
    if (!kind) return;
    setSourceBusy(true);
    setError(undefined);
    setResult(undefined);
    try {
      const prepared = selected.draft
        ? await host.importDraftOutput!(selected.draft, (message) => setProgress(message))
        : await host.importLibraryDocument!(document, (message) => setProgress(message));
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
      setSourcePicker(undefined);
    } catch (caught) {
      setError(errorMessage(caught, "The selected file could not be added."));
    } finally {
      setSourceBusy(false);
      setBusyEntryId(undefined);
      setProgress(undefined);
    }
  }

  const sourceKind = profile.documentKinds.find((item) => item.id === sourcePicker?.kindId);

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
      onLibrary={host.searchLibrary ? (kindId) => openSource(kindId, "library") : undefined}
      onDraftOutput={host.searchDraftOutputs
        ? (kindId) => openSource(kindId, "draft") : undefined}
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
        <div className={cn("builder-header mx-auto flex max-w-[78rem] flex-wrap items-center justify-between gap-3 py-4",
          host.mode === "beaver" ? "pe-4 ps-16 lg:px-6" : "px-4 sm:px-6")}>
          <h1 className="font-serif text-2xl font-semibold leading-tight text-gray-950">{isAffidavit ? "Affidavit Builder" : "Court Record Builder"}</h1>
          <div className="flex min-w-0 max-w-full items-center gap-2">
            {headerActions}
            <DraftMenu
              drafts={drafts}
              current={draft}
              busy={draftBusy}
              itemLabel="court record"
              onNew={() => void newDraft()}
              onOpen={(next) => void saveCurrentDraft().then(() => openDraft(next))}
              onRename={(title) => void renameDraft(title)}
              onDuplicate={() => void duplicateDraft()}
              onDelete={() => void deleteDraft()}
            />
          </div>
        </div>
      </header>
      <div className="court-record-layout mx-auto grid max-w-[78rem] grid-cols-[minmax(0,1fr)] items-start gap-5 px-4 py-5 sm:px-6">
        <WorkspaceElement id="court-record-workspace" tabIndex={-1}
          aria-busy={draftBusy} inert={draftBusy}
          className="min-w-0 space-y-4 outline-none">
          <section className="px-1 pb-1" aria-labelledby="builder-intro-heading">
            <h2 id="builder-intro-heading" className="text-balance font-serif text-xl font-semibold leading-tight text-gray-950 sm:text-2xl">
              {isAffidavit ? "Build an affidavit with exhibits" : `Build ${profile.label.toLowerCase()}`}
            </h2>
            <p className="mt-1 max-w-2xl text-base leading-6 text-gray-600">
              {isAffidavit ? "Add the affidavit, complete the case details, then add the exhibits in order." : "Add the documents, complete the case details, then review and build the record."}
            </p>
          </section>
          <CourtRecordChooser profile={profile} onProfile={chooseProfile} />
          {isAffidavit ? <>
            {documents("1. Add the affidavit", ["affidavit"])}
            {setup("2. Case details")}
            {documents("3. Add exhibits or another document", ["exhibit", "other-document"])}
          </> : <>
            {setup("1. Case details")}
            {documents("2. Add documents")}
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
      </div>
      {sourcePicker && sourceKind && (
        <LibraryDocumentPicker
          open
          title={`Add ${sourceKind.label} from ${sourcePicker.source === "draft" ? "a draft" : "Library"}`}
          formatLabel={sourceFormatLabel(sourceKind)}
          sourceLabel={sourcePicker.source === "draft" ? "draft outputs" : "Library"}
          query={sourceQuery}
          results={sourceResults.map(({ document }) => document)}
          busy={sourceBusy}
          detail={sourcePicker.source === "draft" ? (document) => {
            const draft = sourceResults.find((item) => item.document.id === document.id)?.draft;
            return draft ? `${draft.workProductTitle} · ${draft.role}` : "Draft output";
          } : undefined}
          onQuery={(query) => void searchSources(query)}
          onSelect={(document) => void importSource(document)}
          onClose={() => setSourcePicker(undefined)}
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
  const source = sources[0];
  if (!source) return current;
  const allowed = new Set(profile.cover.fields.map(({ id }) => id));
  const cover = { ...current };
  for (const [field, value] of Object.entries(source.cover)) {
    if (allowed.has(field as keyof typeof source.cover) && value && !cover[field as keyof typeof source.cover]?.trim()) {
      cover[field as keyof typeof source.cover] = value;
    }
  }
  const styles = profile.cover.partyStyles;
  if (!styles?.length || !source.parties) return cover;
  const styleId = cover.partyStyleId || (styles.some(({ id }) => id === source.partyStyleId)
    ? source.partyStyleId : styles[0].id);
  const style = styles.find(({ id }) => id === styleId)!;
  const groups = style.groups.flatMap((definition, index) => {
    const existing = cover.partyGroups?.find(({ id }) => id === definition.id);
    if (definition.optional && !existing) return [];
    const value = index ? source.parties?.second : source.parties?.first;
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
