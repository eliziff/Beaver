import { QuotationReview } from "./QuotationFinding";
import { StepProgress, StepSection } from "./StepSection";
import { FileInputButton } from "./FileInputButton";
import { authorityName, authorityLabel,
  requiresBilingualSources,
  missingSource, sourceAction, relinkable } from "./authorityPresentation";
import { BookOpen, ChevronRight, Download, Eye, FilePlus2, FolderSearch,
  History, Link2, Loader2, Plus, Scale, Settings2 } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState,
  type ComponentType, type ReactNode } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { ChoiceModalButton } from "@/app/components/modals/ChoiceModalButton";
import { CourtChoiceModal } from "@/app/components/modals/CourtChoiceModal";
import { ModalSelect, SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
import { WorkspaceHeader } from "@/app/components/shared/WorkspaceHeader";
import { OutputFolderSetting } from "@/app/components/shared/OutputFolderSetting";
import { MoreActionsMenu } from "@/app/components/shared/MoreActionsMenu";
import type { Document } from "@/app/lib/api/documents";
import type { LibraryDocumentPickerProps } from "@/app/components/shared/LibraryDocumentPicker";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { TabList } from "@/app/components/ui/tabs";
import { Pagination } from "@/app/components/shared/TablePrimitive";
import { downloadBlob } from "@/app/lib/download";
import { cn, errorMessage, formatDateTime } from "@/app/lib/utils";
import type { WorkProductFocus, WorkProductMetadata,
  WorkProductRefresh } from "@/app/lib/workProducts";
import { Sources, type AuthorityPanelProps } from "./AuthoritySources";
import { PdfCanvas } from "@/app/components/shared/views/PdfCanvas";
import { useScannedSources, useSourceOcr } from "./sourceOcr";
import type { AuthoritiesBookSlot, AuthoritiesFile, AuthoritiesHost,
  AuthoritiesLibraryPdfTarget,
  AuthoritiesSourceIssue } from "./host";
import { AUTHORITIES_PROFILES, AUTHORITY_PROFILE_BY_ID, authoritiesProfile } from "./profiles";
import type { AuthoritiesAction, AuthoritiesBuildSettings, AuthoritiesProduct,
  AuthoritiesCover,
  AuthoritiesDiscrepancy, AuthoritiesDiscrepancyAction, AuthoritiesProfileId,
  AuthorityIdentity, AuthorityKind, AuthorityOccurrence, AuthoritySourceLanguage } from "./types";
import { authorityProcedureInput, deriveAuthorityProcedure, tabLabel } from "../../../../shared/authorities-order.mjs";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";

import { AuthoritiesHighlights } from "./AuthoritiesHighlightEditor";

type WorkspaceTab = "automatic" | "manual" | "drafts";
type StartPreferences = Pick<AuthoritiesBuildSettings, "sourceMode" | "passageMarking"> & {
  profileId: AuthoritiesProfileId;
};
type PendingImport = {
  source: { kind: "document"; document: Document } | { kind: "file"; selected: AuthoritiesFile };
  title: string;
  preferences: StartPreferences;
};
const TABS: ReadonlyArray<{ value: WorkspaceTab; label: string }> = [
  { value: "automatic", label: "Automatic" }, { value: "manual", label: "Manual" },
  { value: "drafts", label: "Drafts" },
];
const WORKSPACE_FRAME = "mx-auto w-full max-w-[50rem] px-4 sm:px-6 md:mx-auto";
const SOURCE_LANGUAGE_OPTIONS = [
  { value: "bilingual", label: "English and French", description: "One bilingual official PDF." },
  { value: "en", label: "English", description: "The English official PDF." },
  { value: "fr", label: "French", description: "The French official PDF." },
] as const;
const GENERAL_PROFILE = authoritiesProfile("general");
const DEFAULTS: StartPreferences = {
  profileId: GENERAL_PROFILE.id, sourceMode: GENERAL_PROFILE.defaults.settings.sourceMode,
  passageMarking: GENERAL_PROFILE.defaults.settings.passageMarking,
};
const bookPreferences = (value: StartPreferences) =>
  authoritiesProfile(value.profileId).locked?.outputMode === "table"
    ? withProfile(value, GENERAL_PROFILE.id) : value;
type LibraryPicker = ComponentType<LibraryDocumentPickerProps>;

type LibraryTarget = { kind: "import" } | { kind: "manual" } |
  { kind: "authority"; authorityId: string } |
  Extract<AuthoritiesLibraryPdfTarget, { kind: "book" }>;
type PdfChoice = AuthoritiesFile | Document;
const isLibraryDocument = (selected: PdfChoice): selected is Document => "id" in selected;
const pdfChoiceName = (selected: PdfChoice) => isLibraryDocument(selected)
  ? selected.filename : selected.file.name;
const isPdfChoice = (selected: PdfChoice) => isLibraryDocument(selected)
  ? selected.file_type?.toLowerCase() === "pdf"
  : selected.file.type === "application/pdf" || selected.file.name.toLowerCase().endsWith(".pdf");
function libraryTitle(target: LibraryTarget | undefined, sourceLabel: string) {
  if (target?.kind === "import") return `Choose source document from ${sourceLabel}`;
  if (target?.kind === "book") return `Choose ${target.slot === "supplemental" ? "book PDF" : target.slot} from ${sourceLabel}`;
  return `Choose authority PDF from ${sourceLabel}`;
}
export type AuthoritiesRoute = { draftId: string; projectId?: string;
  replaceDraft: (draftId?: string) => void };
type ActionHandler = (action: AuthoritiesAction,
  done?: (next: AuthoritiesProduct) => void | Promise<void>) => void;
type DiscrepancyHandler = (finding: AuthoritiesDiscrepancy,
  action: AuthoritiesDiscrepancyAction, done: () => void) => void;

export function AuthoritiesWorkspace({ host, headerActions, onDraftChange,
  onFocusChange, refreshToken, locked = false, LibraryPicker, route, jurisdictionOrder = [], onOpenCitation }: {
  onOpenCitation?: AuthorityPanelProps["onOpenCitation"];
  host: AuthoritiesHost;
  route: AuthoritiesRoute;
  headerActions?: ReactNode;
  onDraftChange?: (draft: AuthoritiesProduct | undefined, synced: boolean) => void;
  onFocusChange?: (focus?: WorkProductFocus) => void;
  refreshToken?: WorkProductRefresh;
  locked?: boolean;
  LibraryPicker?: LibraryPicker;
  jurisdictionOrder?: string[];
}) {
  const { draftId: requested, projectId, replaceDraft } = route;
  const routeTarget = useRef<string | null>(null), routeRequest = useRef(0);
  const [tab, setTab] = useState<WorkspaceTab>("automatic");
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const globalTab = tab === "drafts";
  const [preferences, setPreferences] = useState(loadPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("Book of Authorities");
  const [drafts, setDrafts] = useState<WorkProductMetadata[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [restoredScope, setRestoredScope] = useState("");
  const [draft, setDraft] = useState<AuthoritiesProduct>();
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(!!requested), [running, setBusy] = useState(false);
  const [pendingActions, setPendingActions] = useState(0);
  const busy = running || pendingActions > 0;
  const [operation, setOperation] = useState("");
  const [building, setBuilding] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  const [stepFailure, setStepFailure] = useState("");
  const [libraryTarget, setLibraryTarget] = useState<LibraryTarget>(), [addOpen, setAddOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport>();
  const [pendingAttachment, setPendingAttachment] = useState<{
    authorityId: string; selected: PdfChoice;
  }>();
  const [findingId, setFindingId] = useState("");
  const [viewedStep, setViewedStep] = useState<{ key: string; value: Step }>();
  const [editingAuthority, setEditingAuthority] = useState<AuthorityIdentity>();
  const [sourcePreview, setSourcePreview] = useState<{ role: string; name: string;
    quote?: string; bytes?: Uint8Array; error?: string }>();
  const ocr = useSourceOcr(host, draft?.id);
  const [stubWarning, setStubWarning] = useState(false);
  const scanRequest = useRef<AbortController | null>(null);
  const previewRequest = useRef(0);
  const [sourceIssueState, setSourceIssueState] = useState<{
    draftId: string; sourceKey: string; revision: number;
    issues: Record<string, AuthoritiesSourceIssue>;
    outputFreshness: "unbuilt" | "current" | "stale";
  }>({ draftId: "", sourceKey: "", revision: -1, issues: {}, outputFreshness: "unbuilt" });
  const [review, setReview] = useState<{ id: string; key: string;
    items: AuthoritiesDiscrepancy[]; error: string }>();
  const draftRef = useRef(draft);
  const buildRequest = useRef<AbortController | null>(null);
  const reviewRequest = useRef<AbortController | null>(null);
  const inspectionRequest = useRef(0);
  const actionQueue = useRef(Promise.resolve());
  const modeDrafts = useRef<{ automatic?: AuthoritiesProduct; manual?: AuthoritiesProduct }>({});
  const stayOnLanding = useRef(false);
  const refreshSeen = useRef(0), refreshRequest = useRef(0);
  draftRef.current = draft;

  const display = useCallback((next?: AuthoritiesProduct, preserveTab = false) => {
    reviewRequest.current?.abort(); reviewRequest.current = null; setReview(undefined);
    setFindingId(""); setViewedStep(undefined);
    scanRequest.current?.abort(); ocr.reset();
    previewRequest.current += 1; setSourcePreview(undefined);
    draftRef.current = next; setDraft(next); setSelectedId(orderedOccurrences(next)[0]?.id ?? "");
    if (next) {
      modeDrafts.current[next.state.import.kind === "manual" ? "manual" : "automatic"] = next;
      if (!preserveTab) setTab(next.state.import.kind === "manual" ? "manual" : "automatic");
      if (next.state.import.kind === "manual") setManualTitle(next.title);
    }
    setPendingAttachment(undefined); setError(""); setMessage("");
  }, []);
  const remember = useCallback((next: AuthoritiesProduct) => {
    draftRef.current = next; setDraft(next);
    modeDrafts.current[next.state.import.kind === "manual" ? "manual" : "automatic"] = next;
    localStorage.setItem(lastDraftKey(projectId), next.id);
    setDrafts((current) => [metadata(next), ...current.filter(({ id }) => id !== next.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }, [projectId]);
  const open = useCallback((next?: AuthoritiesProduct) => {
    stayOnLanding.current = false;
    display(next); routeTarget.current = next?.id ?? "";
    replaceDraft(next?.id);
  }, [display, replaceDraft]);
  const refreshDraftEffect = useEffectEvent(async (expectedRevision: number) => {
    const current = draftRef.current;
    if (!current || current.revision >= expectedRevision) return;
    const request = ++refreshRequest.current;
    try {
      const next = await host.drafts.get<AuthoritiesProduct["state"]>(current.id);
      if (request === refreshRequest.current && draftRef.current?.id === current.id &&
          next.revision >= expectedRevision && next.revision > (draftRef.current?.revision ?? 0))
        remember(next);
    } catch (caught) {
      if (request === refreshRequest.current) setError(errorText(caught));
    }
  });

  useEffect(() => {
    let active = true;
    setDraftsLoading(true);
    const listed = host.drafts.listMetadata
      ? host.drafts.listMetadata("authorities", projectId)
      : host.drafts.list<AuthoritiesProduct["state"]>("authorities", projectId)
        .then((items) => items.map(metadata));
    void listed.then((items) => active && setDrafts(items))
      .catch((caught) => active && setError(errorText(caught)))
      .finally(() => active && setDraftsLoading(false));
    return () => { active = false; };
  }, [projectId, host]);

  useEffect(() => {
    const scope = projectId ?? "local";
    if (restoredScope === scope || requested || draftRef.current ||
        stayOnLanding.current) return;
    const id = localStorage.getItem(lastDraftKey(projectId));
    if (!id) { setRestoredScope(scope); return; }
    setLoading(true);
    void host.drafts.get<AuthoritiesProduct["state"]>(id).then((next) => {
      remember(next); open(next);
    }).catch(() => localStorage.removeItem(lastDraftKey(projectId)))
      .finally(() => { setRestoredScope(scope); setLoading(false); });
  }, [host, projectId, requested, restoredScope, open, remember]);

  useEffect(() => {
    if (routeTarget.current !== null) {
      const target = routeTarget.current;
      routeTarget.current = null;
      if (requested === target) return;
    }
    const request = ++routeRequest.current;
    if (!requested) { display(); setLoading(false); return; }
    setLoading(!draftRef.current);
    void host.drafts.get<AuthoritiesProduct["state"]>(requested).then((next) => {
      if (next.kind !== "authorities") throw new Error("This is not an Authorities draft.");
      if (request !== routeRequest.current) return;
      remember(next);
      display(next, tabRef.current === "drafts");
    }).catch((caught) => {
      if (request === routeRequest.current) setError(errorText(caught));
    }).finally(() => {
      if (request === routeRequest.current) setLoading(false);
    });
    return () => { routeRequest.current += 1; };
  }, [requested, projectId, display, host, remember]);

  useEffect(() => {
    onDraftChange?.(draft, !!draft && !busy);
  }, [draft, busy, onDraftChange]);
  useEffect(() => localStorage.setItem("beaver.authorities.preferences", JSON.stringify(preferences)),
    [preferences]);
  useEffect(() => () => {
    buildRequest.current?.abort(); scanRequest.current?.abort();
    reviewRequest.current?.abort();
  }, []);
  const draftId = draft?.id;
  const sourceKey = sourceIssueKey(draft);
  const scannedSources = useScannedSources(host, draft, `${draftId}:${sourceKey}`,
    (file) => { if (ocr.tracked[file.role]?.sourceSha256 !== file.sourceSha256) void ocr.begin([file]); });
  const sameDraft = draft && sourceIssueState.draftId === draft.id;
  const sourceIssues = sameDraft && sourceIssueState.sourceKey === sourceKey
    ? sourceIssueState.issues : {};
  const outputFreshness = !draft || !Object.keys(draft.outputs).length ? "unbuilt"
    : sameDraft && sourceIssueState.revision === draft.revision
      ? sourceIssueState.outputFreshness : sameDraft ? "stale" : "current";
  useEffect(() => {
    let active = true;
    const current = draftRef.current;
    if (!current || current.id !== draftId)
      return () => { active = false; };
    const request = ++inspectionRequest.current;
    void host.inspectDraft(current).then((inspection) => active &&
      request === inspectionRequest.current && setSourceIssueState({ draftId: current.id,
        sourceKey: sourceIssueKey(current), revision: current.revision,
        issues: inspection.sourceIssues, outputFreshness: inspection.outputFreshness }))
      .catch((caught) => active && setError(errorText(caught)));
    return () => { active = false; };
  }, [draftId, sourceKey, refreshToken?.sequence, host]);
  const reviewKey = useMemo(() => discrepancyKey(draft), [draft]);
  useEffect(() => {
    reviewRequest.current?.abort();
    if (!draftId || !host.review || !reviewKey) { setReview(undefined); return; }
    const request = new AbortController(); reviewRequest.current = request;
    const id = draftId, key = reviewKey;
    setReview((current) => current?.id === id && current.key === key ? current : undefined);
    void host.review(id, request.signal).then((items) => {
      if (!request.signal.aborted) setReview({ id, key, items, error: "" });
    }).catch((caught) => {
      if (!request.signal.aborted && (caught as { name?: string })?.name !== "AbortError")
        setReview({ id, key, items: [], error: `Source check unavailable. ${errorText(caught)}` });
    }).finally(() => {
      if (reviewRequest.current === request) reviewRequest.current = null;
    });
    return () => request.abort();
  }, [draftId, reviewKey, host]);
  useEffect(() => {
    if (!draftId || refreshToken?.id !== draftId ||
        refreshToken.sequence <= refreshSeen.current) return;
    refreshSeen.current = refreshToken.sequence;
    void refreshDraftEffect(refreshToken.revision);
  }, [draftId, refreshToken]);

  const occurrences = useMemo(() => orderedOccurrences(draft), [draft]);
  const currentReview = review && draft && review.id === draft.id && review.key === reviewKey
    ? review : undefined;
  const discrepancies = currentReview?.items ?? [];
  const selected = occurrences.find(({ id }) => id === selectedId) ?? occurrences[0];
  useEffect(() => { if (!selected) onFocusChange?.(); }, [selected, onFocusChange]);
  const authorityPlan = useMemo(() => draft ? planAuthorities(draft) : [], [draft]);
  const authorities = draft ? authorityPlan.map(({ id }) => draft.state.authorities[id]) : [];
  const authorityTabs = new Map(authorityPlan.map(({ id, tab }) => [id, tab]));
  const missingPdfs = draft ? missingSources(draft) : [];
  const importedRole = draft?.state.import.kind === "document"
    ? draft.state.import.bindingRole : undefined;
  const importedIssue = importedRole ? sourceIssues[importedRole] : undefined;
  const reviewError = !globalTab ? currentReview?.error || "" : "";
  // Work a step starts reports itself in that step, and so does the reason it stopped;
  // only unattached work needs the page-level line.
  const stepError = error && error === stepFailure ? error : "";
  const status = (stepError ? "" : error) || message || reviewError;
  const stepOperation = STEP_PROGRESS.has(operation) ? operation : "";
  const busyText = stepOperation ? "" : building ? "Building outputs"
    : pendingImport ? "Finding citations" : operation || "Updating authorities";
  const libraryAvailable = !!LibraryPicker && !!host.searchLibrary;
  const attachLibraryAvailable = libraryAvailable && !!host.attachLibraryPdf;
  const sourceLabel = (draft?.projectId ?? projectId) ? "Project" : "Library";

  function newDraft(forget = true) {
    stayOnLanding.current = true;
    if (forget) {
      const current = draftRef.current;
      if (current) delete modeDrafts.current[current.state.import.kind === "manual"
        ? "manual" : "automatic"];
      localStorage.removeItem(lastDraftKey(projectId));
    }
    display(); routeTarget.current = ""; replaceDraft();
  }
  function changeTab(next: WorkspaceTab) {
    if (next === "automatic" || next === "manual") {
      const current = draftRef.current;
      const activeMode = current?.state.import.kind === "manual" ? "manual" : "automatic";
      if (current && next !== activeMode) {
        modeDrafts.current[activeMode] = current;
        const target = modeDrafts.current[next];
        if (target) open(target); else newDraft(false);
      } else if (!current && modeDrafts.current[next]) {
        open(modeDrafts.current[next]);
      }
    }
    setTab(next);
    setError(""); setMessage("");
  }
  async function run<T>(operationFn: () => Promise<T>, done: (value: T) => void,
    success = "", label = "Updating authorities") {
    if (busy) return;
    setBusy(true); setOperation(label); setError(""); setMessage("");
    try { const value = await operationFn(); done(value); if (success) setMessage(success); }
    catch (caught) {
      if ((caught as { name?: string })?.name === "AbortError") setMessage("Build cancelled");
      else {
        const text = errorText(caught);
        setError(text); if (STEP_PROGRESS.has(label)) setStepFailure(text);
      }
    }
    finally { setBusy(false); setOperation(""); }
  }
  const act: ActionHandler = (action, done) => {
    const targetId = draftRef.current?.id;
    if (!targetId) return;
    const blocking = action.type !== "rename-authority";
    if (blocking) setPendingActions((count) => count + 1);
    actionQueue.current = actionQueue.current.then(async () => {
      try {
        const current = draftRef.current;
        if (!current || current.id !== targetId) return;
        const prior = "occurrenceId" in action
          ? current.state.occurrences[action.occurrenceId] : null;
        const next = await host.act(current.id, current.revision, action);
        remember(next);
        if (prior) {
          const unit = next.state.units.find(({ id }) => id === prior.unitId);
          const items = unit?.occurrenceIds.flatMap((id) =>
            next.state.occurrences[id] ? [next.state.occurrences[id]] : []) ?? [];
          const replacement = next.state.occurrences[prior.id] ??
            (action.type === "split-occurrence"
              ? items.find(({ start }) => start === action.cursor)
              : items.find(({ start, end }) => start <= prior.start && end >= prior.end));
          if (replacement) setSelectedId(replacement.id);
        }
        await done?.(next);
      } catch (caught) { setError(errorText(caught)); }
      finally { if (blocking) setPendingActions((count) => Math.max(0, count - 1)); }
    });
  };
  const resolveDiscrepancy: DiscrepancyHandler = (finding, action, done) => {
    const current = draftRef.current;
    if (!current || !host.resolveDiscrepancy) return;
    void run(() => host.resolveDiscrepancy!(current.id,
      { id: finding.id, action, revision: current.revision }), (next) => {
      remember(next); done();
    }, action === "ignore" ? "Quotation difference dismissed"
      : host.mode === "standalone" ? "Corrected Word copy saved with this draft"
        : "Source corrected and draft refreshed", "Correcting source");
  };

  function queueDocument(document: Document) {
    setLibraryTarget(undefined); setError(""); setMessage("");
    setPendingImport({ source: { kind: "document", document },
      title: document.filename.replace(/\.[^.]+$/u, "") || "Authorities", preferences });
  }
  function queueFile(selected?: AuthoritiesFile) {
    if (!selected) return;
    setError(""); setMessage("");
    setPendingImport({ source: { kind: "file", selected },
      title: selected.file.name.replace(/\.[^.]+$/u, "") || "Authorities", preferences });
  }
  function importDocument() {
    if (!pendingImport) return;
    void run(() => host.create({ ...pendingImport, projectId,
      settings: pendingImport.preferences }), (next) => {
      setPreferences(pendingImport.preferences); setPendingImport(undefined);
      remember(next); open(next);
    });
  }
  async function pickFiles(multiple: boolean, accept: "source" | "pdf",
    done: (files: AuthoritiesFile[]) => void) {
    try { done(await host.pickFiles?.({ multiple, accept }) ?? []); }
    catch (caught) {
      if ((caught as { name?: string })?.name !== "AbortError") setError(errorText(caught));
    }
  }
  function appendManual(files: PdfChoice[]) {
    const pdfs = files.filter(isPdfChoice);
    if (!pdfs.length) { setError("Add one or more PDFs."); return; }
    void run(async () => {
      const manualPreferences = bookPreferences(preferences);
      let current = draft?.state.import.kind === "manual" ? draft : await host.create({
        source: { kind: "manual" }, title: manualTitle.trim() || "Book of Authorities",
        projectId, settings: { ...manualPreferences, sourceMode: "manual-originals",
          passageMarking: "margin", outputMode: "book" },
      });
      if (current !== draft) { remember(current); open(current); }
      for (let index = 0; index < pdfs.length; index += 1) {
        const selected = pdfs[index], before = new Set(current.state.authorityOrder);
        const filename = pdfChoiceName(selected);
        const label = filename.replace(/\.pdf$/iu, "").replace(/[_-]+/gu, " ").trim()
          || `Authority ${index + 1}`;
        setMessage(`Adding ${index + 1} of ${pdfs.length}`);
        current = await host.act(current.id, current.revision,
          { type: "add-authority", kind: "other", citation: label, name: label });
        remember(current);
        const authorityId = current.state.authorityOrder.find((id) => !before.has(id));
        if (!authorityId) throw new Error("The PDF could not be added.");
        current = isLibraryDocument(selected)
          ? await host.attachLibraryPdf!(current.id, current.revision, selected,
            { kind: "authority", authorityId, language: "en" })
          : await host.attach(current.id, authorityId, current.revision, selected);
        remember(current);
      }
      return current;
    }, (next) => { remember(next); open(next); }, `${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"} added`);
  }
  function attach(authorityId: string, selected?: PdfChoice,
    language?: AuthoritySourceLanguage) {
    const current = draftRef.current, authority = current?.state.authorities[authorityId];
    if (!current || !authority || !selected) return;
    if (!language && requiresBilingualSources(current.state, authority)) {
      setPendingAttachment({ authorityId, selected }); return;
    }
    void run(() => isLibraryDocument(selected)
      ? host.attachLibraryPdf!(current.id, current.revision, selected,
        { kind: "authority", authorityId, language: language ?? "en" })
      : host.attach(current.id, authorityId, current.revision, selected, language), remember,
    `${pdfChoiceName(selected)} attached`);
  }
  function attachBookFiles(slot: AuthoritiesBookSlot,
    selected: PdfChoice[], supplementId?: string) {
    if (!draft || !selected.length || (!host.attachBookPdf && !host.attachLibraryPdf)) return;
    const files = slot === "supplemental" && !supplementId ? selected : selected.slice(0, 1);
    void run(async () => {
      let current = draft;
      for (let index = 0; index < files.length; index += 1) {
        const selected = files[index];
        setMessage(files.length > 1 ? `Adding ${index + 1} of ${files.length}` : "Adding file");
        current = isLibraryDocument(selected)
          ? await host.attachLibraryPdf!(current.id, current.revision, selected,
            { kind: "book", slot, supplementId })
          : await host.attachBookPdf!(current.id, current.revision, slot, selected, supplementId);
        remember(current);
      }
      return current;
    }, remember, files.length > 1 ? `${files.length} files added` : `${pdfChoiceName(files[0])} added`);
  }

  function openLibrary(target: LibraryTarget) {
    setLibraryTarget(target);
  }

  function chooseLibrary(document: Document) {
    const target = libraryTarget;
    setLibraryTarget(undefined);
    if (!target) return;
    if (target.kind === "import") queueDocument(document);
    else if (target.kind === "manual") appendManual([document]);
    else if (target.kind === "authority") attach(target.authorityId, document);
    else attachBookFiles(target.slot, [document], target.supplementId);
  }
  function relinkSource(role: string) {
    if (!draft || !host.relinkSource) return;
    void run(() => host.relinkSource!(draft.id, role, draft.revision), (next) => {
      remember(next);
      setSourceIssueState((current) => {
        const { [role]: _resolved, ...issues } = current.issues;
        return { ...current, issues };
      });
    },
      "Source relinked");
  }
  function rename(title: string) {
    if (draft) void run(() => host.drafts.update<AuthoritiesProduct["state"]>(draft.id,
      { revision: draft.revision, title }), (next) => { remember(next); if (next.state.import.kind === "manual") setManualTitle(next.title); });
  }
  function duplicate() {
    if (!draft) return;
    void run(() => host.drafts.duplicate<AuthoritiesProduct["state"]>(draft.id,
      { title: `${draft.title} copy` }), (next) => { remember(next); open(next); });
  }
  function removeDraft() {
    if (!draft) return;
    const id = draft.id;
    void run(() => host.drafts.remove(id), () => {
      setDrafts((current) => current.filter((item) => item.id !== id)); newDraft();
    });
  }
  function build(current = draftRef.current, force = false) {
    if (!current) return;
    if (!force && !current.state.settings.allowIncomplete && missingSources(current).length) {
      setStubWarning(true); return;
    }
    const request = new AbortController(); buildRequest.current = request; setBuilding(true);
    void run(() => host.build(current, setMessage, request.signal),
      ({ product, notice }) => {
        inspectionRequest.current += 1;
        setSourceIssueState((current) => {
          const key = sourceIssueKey(product);
          return { draftId: product.id, sourceKey: key, revision: product.revision,
            issues: current.draftId === product.id && current.sourceKey === key
              ? current.issues : {}, outputFreshness: "current" };
        });
        remember(product); setMessage(notice || "Outputs ready");
      }).finally(() => {
        if (buildRequest.current === request) {
          buildRequest.current = null; setBuilding(false);
        }
      });
  }
  function download(documentId: string, versionId: string, filename: string) {
    void host.download(documentId, versionId).then((blob) => downloadBlob(blob, filename))
      .catch((caught) => setError(errorText(caught)));
  }
  function openSource(role: string, quote?: string) {
    const current = draftRef.current;
    if (!current || !host.readSource) return;
    const request = ++previewRequest.current;
    const authority = Object.values(current.state.authorities).find((item) =>
      item.source.kind === "attached" && item.source.sources.some((source) => source.bindingRole === role));
    const name = authority ? authorityName(authority) : current.title;
    setSourcePreview({ role, name, quote });
    void host.readSource(current, role).then((blob) => blob.arrayBuffer()).then((buffer) => {
      if (request === previewRequest.current && draftRef.current?.id === current.id)
        setSourcePreview({ role, name, quote, bytes: new Uint8Array(buffer) });
    }).catch((caught) => {
      if (request === previewRequest.current) setSourcePreview({ role, name, quote, error: errorText(caught) });
    });
  }
  // The quotation belongs at the pinpoint the author cited, so open the PDF on that passage.
  function openFindingSource(finding: AuthoritiesDiscrepancy) {
    const source = draftRef.current?.state.authorities[finding.authorityId]?.source;
    const role = source?.kind === "attached" ? source.sources[0]?.bindingRole : undefined;
    if (role) openSource(role, (finding.found ?? finding.cited).text);
  }
  function findSources() {
    const current = draftRef.current;
    if (!current) return;
    const request = new AbortController(); scanRequest.current?.abort(); scanRequest.current = request;
    void run(async () => {
      const prepared = await host.prepareSources(current, request.signal);
      request.signal.throwIfAborted();
      remember(prepared);
      return host.act(prepared.id, prepared.revision, { type: "set-stage", stage: "sources" });
    }, remember, "", "Finding source PDFs").finally(() => {
      if (scanRequest.current === request) scanRequest.current = null;
    });
  }
  const reached = draft?.state.stage ?? (draft && Object.keys(draft.outputs).length ? "build"
    : draft?.state.import.kind === "manual" ? "sources" : "citations");
  const stepKey = `${draft?.id}:${reached}`;
  const stage = viewedStep?.key === stepKey ? viewedStep.value : reached;
  const steps = STEPS.filter(({ value }) => value !== "citations" || draft?.state.import.kind !== "manual")
    .map(step => ({ ...step, disabled: busy || STEPS.findIndex(({ value }) => value === step.value) >
      STEPS.findIndex(({ value }) => value === reached) }));
  const viewStep = (value: Step) => setViewedStep({ key: stepKey, value });
  const advance = (next: Step) => {
    if (STEPS.findIndex(({ value }) => value === next) <= STEPS.findIndex(({ value }) => value === reached)) viewStep(next);
    else act({ type: "set-stage", stage: next });
  };
  const buildPanel = draft && stage === "build" && <BuildPanel draft={draft} busy={busy} building={building}
    jurisdictionOrder={jurisdictionOrder} outputFreshness={outputFreshness}
    missing={missingPdfs.length} onAction={act} sourceIssues={sourceIssues}
    onRelink={relinkSource} onOpenSource={host.readSource ? openSource : undefined}
    onBookFiles={(slot, files, supplementId) => attachBookFiles(slot,
      files.map((file) => ({ file })), supplementId)}
    onPickBook={host.pickFiles ? (slot, multiple, supplementId) => void pickFiles(
      multiple, "pdf", (files) => attachBookFiles(slot, files, supplementId)) : undefined}
    onLibraryBook={attachLibraryAvailable
      ? (slot, supplementId) => openLibrary({ kind: "book", slot, supplementId }) : undefined}
    sourceLabel={sourceLabel} onBuild={() => build()} onCancel={() => buildRequest.current?.abort()}
    onDownload={download} />;
  const highlightPanel = draft && stage === "highlights" && <AuthoritiesHighlights product={draft} tabs={authorityTabs}
    busy={busy} host={host} ocr={ocr} onSaved={remember} />;
  const quotationReview = draft && findingId && discrepancies.length > 0 &&
    <QuotationReview items={currentReview?.items} currentId={findingId}
      busy={busy || !currentReview} error={error || currentReview?.error} onSelect={setFindingId}
      onOpenSource={host.readSource ? openFindingSource : undefined}
      onResolve={host.resolveDiscrepancy ? resolveDiscrepancy : undefined}
      onDone={() => setFindingId("")} />;
  const authorityPanelProps = { authorities, tabs: authorityTabs, busy, sourceIssues, ocr,
    onOpenCitation,
    inspection: scannedSources,
    onAction: act, onEditIdentity: setEditingAuthority,
    onOpenSource: host.readSource ? openSource : undefined, onAdd: () => setAddOpen(true),
    onPick: host.pickFiles ? (id: string) => void pickFiles(false, "pdf",
      (files) => attach(id, files[0])) : undefined,
    onLibrary: attachLibraryAvailable
      ? (authorityId: string) => openLibrary({ kind: "authority", authorityId }) : undefined,
    sourceLabel, onAttach: (id: string, file?: File) => attach(id, file && { file }),
    onRelink: relinkSource };

  const settingsAction = <Button type="button" variant="outline" aria-label="Settings"
    className="h-9 w-9 shrink-0 border-gray-400 px-0 sm:w-auto sm:px-4"
    disabled={busy || locked} onClick={() => setSettingsOpen(true)}>
    <Settings2 /><span className="hidden sm:inline">Settings</span></Button>;

  return <div className={cn("authorities-workspace bg-app-background [scrollbar-gutter:stable]",
    host.mode === "standalone" ? "min-h-dvh" : "min-h-full lg:h-full lg:min-h-0 lg:overflow-y-auto")}>
    {draft ? <WorkspaceHeader className={host.mode === "standalone" ? WORKSPACE_FRAME : undefined} current={draft}
        busy={busy || locked} itemLabel="authorities draft"
        onBack={() => newDraft(false)} onRename={rename} onDuplicate={duplicate}
        onDelete={removeDraft} headerActions={<><Button type="button" variant="outline"
          className="h-9 border-gray-400" disabled={busy || locked} onClick={() => newDraft()}>
          <Plus /> New</Button>{headerActions}{settingsAction}</>} />
        : <WorkspaceHeader className={host.mode === "standalone" ? WORKSPACE_FRAME : undefined} title="Authorities"
          headerActions={<>{headerActions}{settingsAction}</>} />}
    <div inert={locked} aria-busy={locked || undefined}>
          <main className={cn(WORKSPACE_FRAME, "min-h-80 py-4")}>
        <TabList value={tab} onValueChange={changeTab} options={TABS}
          ariaLabel="Authorities sections" variant="dock" panelId="authorities-panel"
          className="mb-1 min-h-0 border-0 bg-transparent px-0 py-0 sm:px-0 max-[22rem]:[&_.tab-list]:justify-between max-[22rem]:[&_.tab-list]:gap-0 max-[22rem]:[&_[role=tab]]:px-1 max-[22rem]:[&_[role=tab]]:text-xs" />
        <Status busy={busy}
          busyText={busyText} status={status} error={!!(error || (!message && reviewError))} />
        <div id="authorities-panel" role="tabpanel"
          aria-labelledby={`authorities-panel-tab-${TABS.findIndex(({ value }) => value === tab)}`}>
        {loading || (!requested && !stayOnLanding.current &&
          !!localStorage.getItem(lastDraftKey(projectId)) &&
          restoredScope !== (projectId ?? "local")) ? <Loading /> : tab === "drafts"
          ? <DraftsPanel drafts={drafts} loading={draftsLoading} busy={busy} onOpen={(id) => void run(
              () => host.drafts.get<AuthoritiesProduct["state"]>(id), (next) => {
                remember(next); open(next);
              }, "", "Opening draft")} />
            : !draft
              ? tab === "manual"
                ? <ManualStart title={manualTitle} busy={busy} onTitle={setManualTitle}
                    preferences={bookPreferences(preferences)} onPreferences={setPreferences}
                    jurisdictionOrder={jurisdictionOrder}
                    onPick={host.pickFiles ? () => void pickFiles(true, "pdf", appendManual) : undefined}
                    onLibrary={attachLibraryAvailable ? () => openLibrary({ kind: "manual" }) : undefined}
                    sourceLabel={sourceLabel}
                    onFiles={(files) => appendManual(files.map((file) => ({ file })))} />
                : <AutomaticStart busy={busy}
                    onPick={host.pickFiles ? () => void pickFiles(false, "source",
                      (files) => queueFile(files[0])) : undefined}
                    onFile={(file) => queueFile(file && { file })}
                    onLibrary={libraryAvailable ? () => openLibrary({ kind: "import" }) : undefined}
                    sourceLabel={sourceLabel} />
              : <>
                  <TabList value={stage} onValueChange={viewStep} options={steps}
                    ariaLabel="Book steps" variant="subtab" panelId="authorities-step" />
                  <div id="authorities-step" role="tabpanel"
                    aria-labelledby={`authorities-step-tab-${steps.findIndex(({ value }) => value === stage)}`}>
                  {stage === "citations" && draft.state.import.kind === "document" && <><StepSection title="Import and review" subtitle={draft.state.import.filename}
                    subtitleTitle={draft.state.import.filename}
                    actions={<>
                      {importedRole && importedIssue && host.relinkSource &&
                        relinkable(importedIssue) && <Button type="button"
                        variant="outline" className="h-9 border-gray-400" disabled={busy}
                        onClick={() => relinkSource(importedRole)}><FilePlus2 />
                        {sourceAction(importedIssue, "source")}</Button>}
                      <StepProgress label={stepOperation} error={stepError} />
                      <Button disabled={busy} className="h-9" onClick={() => reached === "citations" ? findSources() : viewStep("sources")}>
                        Done<ChevronRight /></Button>
                    </>}>
                    {operation !== "Finding source PDFs" && <CitationReview occurrences={occurrences} units={draft.state.units}
                      selected={selected} authorities={authorities} discrepancies={discrepancies}
                      busy={busy} onSelect={setSelectedId} onAction={act}
                      onFocusChange={onFocusChange} onReview={setFindingId} />}
                  </StepSection>{quotationReview}</>}
                  {stage === "sources" && <><Sources key={draft.id} draft={draft} occurrences={occurrences}
                    {...authorityPanelProps}
                    {...(draft.state.import.kind === "manual" ? {
                      onPickMany: host.pickFiles ? () => void pickFiles(true, "pdf", appendManual) : undefined,
                      onLibraryAdd: attachLibraryAvailable ? () => openLibrary({ kind: "manual" }) : undefined,
                      onFiles: (files: File[]) => appendManual(files.map((file) => ({ file }))),
                    } : {})} />
                    <div className="mt-3 flex items-center justify-end gap-3">
                      <StepProgress label={stepOperation} error={stepError} />
                      <Button disabled={busy} onClick={() => advance("highlights")}>Done<ChevronRight /></Button>
                    </div></>}
                  {highlightPanel}
                  {stage === "highlights" && <div className="mt-3 flex justify-end">
                    <Button disabled={busy} onClick={() => advance("build")}>
                      Done — build book<ChevronRight /></Button></div>}
                  {buildPanel}
                  </div>
                </>}
        </div>
      </main>
      {LibraryPicker && <LibraryPicker open={!!libraryTarget}
        key={`${draft?.id}:${draft?.projectId ?? projectId}:${libraryTarget?.kind}`}
        title={libraryTitle(libraryTarget, sourceLabel)}
        formatLabel={libraryTarget?.kind === "import" ? "PDF or Word" : "PDF"}
        sourceLabel={sourceLabel}
        search={(query, signal) => host.searchLibrary?.(query, {
          projectId: draft?.projectId ?? projectId,
          formats: libraryTarget?.kind === "import" ? ["pdf", "docx"] : ["pdf"],
        }, signal) ?? Promise.resolve([])}
        onError={(caught) => setError(errorText(caught))}
        onSelect={chooseLibrary} onClose={() => setLibraryTarget(undefined)} />}
      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} size="xl"
        breadcrumbs={["Settings"]} fit
        primaryAction={{ label: "Done", onClick: () => setSettingsOpen(false) }}>
        <p className="mb-4 text-sm text-gray-600">Defaults for new authorities drafts.</p>
        <AuthoritiesSetupFields value={preferences} onChange={setPreferences}
          busy={busy} jurisdictionOrder={jurisdictionOrder} />
        {host.outputFolder && <div className="mt-5 border-t border-gray-200 pt-4">
          <OutputFolderSetting port={host.outputFolder} busy={busy} />
        </div>}
      </Modal>
      <ImportSetup pending={pendingImport} busy={busy} status={error}
        jurisdictionOrder={jurisdictionOrder}
        onChange={(next) => setPendingImport((current) => current
          ? { ...current, preferences: next } : current)}
        onClose={() => { if (!busy) setPendingImport(undefined); }} onImport={importDocument} />
      {addOpen && <AuthorityDetailsModal open busy={busy} onClose={() => setAddOpen(false)}
        onSave={(kind, citation, name) => {
          setAddOpen(false);
          act({ type: "add-authority", kind, citation, name }, async (next) => {
            if (next.state.stage !== "citations") {
              setOperation("Finding source PDF");
              try { remember(await host.prepareSources(next)); }
              finally { setOperation(""); }
            }
          });
        }} />}
      {editingAuthority && <AuthorityDetailsModal open busy={busy} authority={editingAuthority}
        onClose={() => setEditingAuthority(undefined)} onSave={(kind, citation, name) => {
          act({ type: "edit-authority", authorityId: editingAuthority.id, kind, citation, name });
          setEditingAuthority(undefined);
        }} />}
      <Modal open={stubWarning} onClose={() => setStubWarning(false)} size="md"
        breadcrumbs={["Missing PDFs"]} fit
        secondaryAction={{ label: "Cancel", onClick: () => setStubWarning(false) }}
        primaryAction={{ label: "Build anyway", disabled: busy, onClick: () => {
          setStubWarning(false);
          act({ type: "set-settings", settings: { allowIncomplete: true } },
            (next) => build(next, true));
        } }}>
        <p className="pb-4 text-sm text-gray-700">{missingPdfs.length} authorit{missingPdfs.length === 1
          ? "y has" : "ies have"} no PDF. Labelled stub pages will hold those tab slots and the build will not be filing-ready.</p>
      </Modal>
      <Modal open={!!sourcePreview} size="2xl" breadcrumbs={[sourcePreview?.name ?? "Source PDF"]}
        className="h-[min(900px,calc(100dvh-2rem))] [&_.modal-body]:p-0"
        onClose={() => { previewRequest.current += 1; setSourcePreview(undefined); }}>
        <div className="h-[min(70dvh,750px)] min-h-60">
          <PdfCanvas bytes={sourcePreview?.bytes} loading={!!sourcePreview && !sourcePreview.bytes && !sourcePreview.error}
            error={sourcePreview?.error} quoteFocusKey={sourcePreview?.quote}
            quotes={sourcePreview?.quote ? [{ quote: sourcePreview.quote }] : undefined} />
        </div>
      </Modal>
      <SearchableChoiceModal open={!!pendingAttachment} title="PDF language" searchable={false}
        value={null} options={SOURCE_LANGUAGE_OPTIONS} onClose={() => setPendingAttachment(undefined)}
        onChange={(value) => {
          const pending = pendingAttachment; setPendingAttachment(undefined);
          if (pending && value) attach(pending.authorityId, pending.selected,
            value as AuthoritySourceLanguage);
        }} />
    </div>
  </div>;

}

function Loading() {
  return <div className="grid h-80 place-items-center rounded-xl border border-gray-300 bg-white text-sm text-gray-600" role="status">
    <span className="inline-flex items-center"><Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" /> Loading authorities</span>
  </div>;
}

function AutomaticStart({ busy, onFile, onPick, onLibrary, sourceLabel = "Library" }: {
  busy: boolean; onFile: (file?: File) => void;
  onPick?: () => void; onLibrary?: () => void; sourceLabel?: string;
}) {
  return <section className="max-w-xl rounded-xl border border-gray-300 bg-white p-4 shadow-sm sm:p-5">
    <div className="flex items-center gap-3"><Scale className="h-6 w-6 shrink-0 text-red-700" aria-hidden="true" />
      <div className="min-w-0"><h2 className="font-semibold text-gray-950">Import and review</h2>
        <p className="text-sm text-gray-600">Add a factum, brief, or other PDF or Word document.</p></div></div>
    <div className="mt-5 flex flex-wrap gap-2">
      {onPick ? <Button type="button" disabled={busy} onClick={onPick}>
        <FilePlus2 /> Add file</Button> : <FileInputButton multiple={false} disabled={busy}
          label="Add file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onFiles={(files) => onFile(files[0])} />}
      {onLibrary && <Button type="button" variant="outline" className="border-gray-400"
        disabled={busy} onClick={onLibrary}><FolderSearch /> {sourceLabel}</Button>}
    </div>
  </section>;
}

function ImportSetup({ pending, busy, status, jurisdictionOrder, onChange, onClose, onImport }: {
  pending?: PendingImport; busy: boolean; status: string;
  jurisdictionOrder: string[];
  onChange: (value: StartPreferences) => void; onClose: () => void; onImport: () => void;
}) {
  const value = pending?.preferences ?? DEFAULTS;
  return <Modal open={!!pending} onClose={onClose} size="xl" breadcrumbs={["Import options"]}
    className="!h-[min(32rem,calc(100dvh-2rem))]"
    footerStatus={status && <span className="text-sm text-red-800" role="status">{status}</span>}
    primaryAction={{ label: busy ? "Finding citations" : "Import and review", disabled: busy,
      icon: busy ? <Loader2 className="motion-safe:animate-spin" /> : undefined,
      onClick: onImport }}>
    <p className="mb-4 truncate text-sm text-gray-600" title={pending?.title}>{pending?.title}</p>
    <AuthoritiesSetupFields value={value} onChange={onChange} busy={busy}
      jurisdictionOrder={jurisdictionOrder} />
    <div className="h-5" />
  </Modal>;
}

function ManualStart({ title, busy, preferences, jurisdictionOrder,
  onTitle, onPreferences, onPick, onFiles, onLibrary, sourceLabel = "Library" }: {
  title: string; busy: boolean; onTitle: (value: string) => void;
  preferences: StartPreferences; jurisdictionOrder: string[];
  onPreferences: (value: StartPreferences) => void;
  onPick?: () => void; onFiles: (files: File[]) => void;
  onLibrary?: () => void; sourceLabel?: string;
}) {
  return <section className="rounded-xl border border-gray-300 bg-white p-4 shadow-sm sm:p-5">
    <div className="flex items-center gap-3"><BookOpen className="h-6 w-6 shrink-0 text-red-700" aria-hidden="true" />
      <div className="min-w-0"><h2 className="font-semibold text-gray-950">Build a book from PDFs</h2>
        <p className="text-sm text-gray-600">Add the authorities in the order you want them.</p></div></div>
    <label className="mt-5 block text-sm font-medium text-gray-800">Book title
      <Input value={title} onChange={(event) => onTitle(event.target.value)}
        className="mt-1 h-10 border-gray-400 md:text-base" /></label>
    <AuthoritiesCourtField value={preferences.profileId} disabled={busy}
      preferredKeys={jurisdictionOrder} className="mt-4 w-full" bookOnly
      onChange={(profileId) => onPreferences(withProfile(preferences, profileId))} />
    <div className="mt-4 flex flex-wrap gap-2">
        {onPick ? <Button type="button" className="h-11" disabled={busy} onClick={onPick}>
        <FilePlus2 /> Add files</Button> : <FileInputButton multiple disabled={busy}
          label="Add files" accept=".pdf,application/pdf" onFiles={onFiles} />}
        {onLibrary && <Button type="button" variant="outline" className="h-11 border-gray-400"
          disabled={busy} onClick={onLibrary}><FolderSearch /> {sourceLabel}</Button>}
    </div>
  </section>;
}

function DraftsPanel({ drafts, loading, busy, onOpen }: { drafts: WorkProductMetadata[];
  loading: boolean; busy: boolean; onOpen: (id: string) => void }) {
  const pages = Math.max(1, Math.ceil(drafts.length / 8));
  const [requestedPage, setPage] = useState(1), page = Math.min(requestedPage, pages);
  return <section className="overflow-hidden rounded-xl border border-gray-300 bg-white shadow-sm">
    <div className="flex min-h-12 items-center gap-2 border-b border-gray-200 px-4">
      <History className="h-4 w-4 shrink-0 text-red-700" />
      <h2 className="font-semibold text-gray-950">Saved drafts</h2>
      <span className="ms-auto text-sm tabular-nums text-gray-500">{drafts.length}</span></div>
    <div className="h-[28rem] overflow-y-auto">
      {loading ? <div className="grid h-full place-items-center px-4 py-12 text-sm text-gray-500"
        role="status"><span className="inline-flex items-center"><Loader2
          className="mr-2 h-4 w-4 motion-safe:animate-spin" />Loading saved drafts</span></div>
        : drafts.slice((page - 1) * 8, page * 8).map((item) => <button key={item.id} type="button" disabled={busy}
        onClick={() => onOpen(item.id)} className="grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-gray-100 px-4 text-left outline-none last:border-0 hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600">
        <span className="min-w-0"><span className="block truncate text-sm font-medium text-gray-950">{item.title}</span>
          <span className="block text-xs text-gray-500">{formatDateTime(item.updatedAt)}</span></span>
        <ChevronRight className="h-4 w-4 text-gray-500" />
      </button>)}
      {!loading && !drafts.length && <p className="grid h-full place-items-center px-4 py-12 text-center text-sm text-gray-500">No saved drafts yet.</p>}
    </div>
    {!loading && !!drafts.length && <Pagination page={page} pages={pages}
      label="Saved drafts" disabled={busy} onPage={setPage} />}
  </section>;
}

function AuthoritiesCourtField({ value, disabled, preferredKeys, onChange, className,
  bookOnly = false }: {
  value: AuthoritiesProfileId; disabled?: boolean; preferredKeys: string[];
  onChange: (value: AuthoritiesProfileId) => void; className?: string; bookOnly?: boolean;
}) {
  const current = authoritiesProfile(value);
  const [open, setOpen] = useState(false);
  const available = AUTHORITIES_PROFILES
    .filter((item) => !bookOnly || item.locked?.outputMode !== "table");

  return <div className={className}>
    <ChoiceModalButton icon={<Scale aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" />}
      label="Court" value={current.label} disabled={disabled} className="w-full"
      onClick={() => setOpen(true)} />
    <CourtChoiceModal open={open} title="Choose court" searchLabel="Search courts"
      value={value} preferredKeys={preferredKeys}
      options={available.map(({ id, label, court, jurisdiction }) => ({ value: id, label,
        jurisdictionId: jurisdiction.id, keywords: court.abbreviation }))}
      onChange={(id) => onChange(id as AuthoritiesProfileId)} onClose={() => setOpen(false)} />
  </div>;
}

function AuthoritiesSetupFields({ value, onChange, busy, jurisdictionOrder }: {
  value: StartPreferences; onChange: (value: StartPreferences) => void; busy: boolean;
  jurisdictionOrder: string[];
}) {
  return <>
    <AuthoritiesCourtField value={value.profileId} disabled={busy}
      preferredKeys={jurisdictionOrder}
      onChange={(profileId) => onChange(withProfile(value, profileId))} />
    <OptionCards legend="Source handling" value={value.sourceMode} options={SOURCE_OPTIONS} disabled={busy}
      className="mt-5"
      onChange={(sourceMode) => onChange({ ...value, sourceMode })} />
    <OptionCards className="mt-5" legend="Passage marking" value={value.passageMarking}
      options={passageOptions(value.profileId)} columns disabled={busy}
      onChange={(passageMarking) => onChange({ ...value, passageMarking })} />
  </>;
}

function CitationReview({ occurrences, units, selected, authorities, discrepancies, onSelect,
  onAction, onReview, busy, onFocusChange }: {
  occurrences: AuthorityOccurrence[]; selected?: AuthorityOccurrence;
  units: AuthoritiesProduct["state"]["units"]; authorities: AuthorityIdentity[];
  discrepancies: AuthoritiesDiscrepancy[]; busy: boolean;
  onSelect: (id: string) => void; onAction: ActionHandler;
  onFocusChange?: (focus?: WorkProductFocus) => void;
  onReview: (id: string) => void;
}) {
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  if (!occurrences.length) return <div className="grid h-80 place-items-center text-sm text-gray-500">No citations found.</div>;
  const unit = units.find(({ id }) => id === selected?.unitId), unitText = unit?.text ?? selected?.text ?? "";
  const authorityById = new Map(authorities.map((item) => [item.id, item]));
  const findingByOccurrence = new Map(discrepancies.map((item) => [item.occurrenceId, item]));
  return <div className="authorities-review grid min-h-0 grid-rows-[14rem_auto] overflow-hidden @min-[35rem]:h-[30rem] @min-[35rem]:grid-cols-[18rem_minmax(0,1fr)]! @min-[35rem]:grid-rows-1">
    <div className="min-h-0 overflow-y-auto border-b border-gray-200 [scrollbar-width:thin] @min-[35rem]:border-b-0 @min-[35rem]:border-e" role="listbox"
      aria-label="Citations">
      {occurrences.map((item, index) => {
        const authority = item.authorityId ? authorityById.get(item.authorityId) : undefined;
        const finding = findingByOccurrence.get(item.id);
        return <button key={item.id} ref={(node) => { options.current[index] = node; }}
          type="button" role="option" aria-selected={item.id === selected?.id}
          tabIndex={item.id === selected?.id ? 0 : -1} onClick={() => onSelect(item.id)}
          onKeyDown={(event) => {
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? occurrences.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + occurrences.length) % occurrences.length;
            onSelect(occurrences[next].id);
            options.current[next]?.focus();
          }} className={cn("block min-h-[3.6rem] w-full border-b border-s-4 border-gray-100 px-3 py-2 text-left outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600", item.id === selected?.id ? "border-s-red-700 bg-red-50" : "border-s-transparent hover:bg-red-50")}>
          <span className="flex min-w-0 items-center gap-2 text-xs text-gray-500">
            <span className="min-w-0 flex-1 truncate">{location(item, index, occurrences, units)}</span>
            {finding && <span className="shrink-0 font-medium text-red-800">Check quotation</span>}
          </span>
          {authority && authorityName(authority) !== authority.citation &&
            <span className="block truncate text-sm font-semibold text-gray-900">{authorityName(authority)}</span>}
          <span className="block truncate text-xs text-gray-700">{item.citation}</span>
        </button>;
      })}
    </div>
    {selected && <CitationEditor key={selected.id} selected={selected} unitText={unitText}
      footnote={unit?.kind === "footnote"} canMerge={(unit?.occurrenceIds.indexOf(selected.id) ?? 0) > 0}
      authorities={authorities} busy={busy} finding={findingByOccurrence.get(selected.id)}
      onFocusChange={onFocusChange} onAction={onAction} onReview={onReview} />}
  </div>;
}

function CitationEditor({ selected, unitText, footnote, canMerge, authorities, finding, onAction,
  onReview, busy, onFocusChange }: {
  selected: AuthorityOccurrence; unitText: string; footnote: boolean; canMerge: boolean;
  authorities: AuthorityIdentity[]; onAction: ActionHandler; busy: boolean;
  finding?: AuthoritiesDiscrepancy;
  onReview: (id: string) => void;
  onFocusChange?: (focus?: WorkProductFocus) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const linked = authorities.find(({ id }) => id === selected.reference?.targetAuthorityId);
  const rememberSelection = () => setSelection(selectionRange(surface.current));
  useEffect(() => onFocusChange?.({ itemId: selected.id,
    ...(selection && { selection }) }),
  [onFocusChange, selected.id, selection]);
  useEffect(() => () => onFocusChange?.(), [onFocusChange]);
  useEffect(() => {
    const update = () => setSelection(selectionRange(surface.current));
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, []);
  useLayoutEffect(() => {
    setSelection(null);
    const root = surface.current;
    const marks = root && [...root.querySelectorAll<HTMLElement>("[data-authority-span]")];
    if (!root || !marks?.length) return;
    const rootBox = root.getBoundingClientRect(), first = marks[0].getBoundingClientRect(),
      last = marks[marks.length - 1].getBoundingClientRect();
    root.scrollTop += (first.top + last.bottom - rootBox.top * 2 - rootBox.height) / 2;
  }, [selected.id, selected.authoritySpan.start, selected.authoritySpan.end, unitText]);
  const submit = (action: AuthoritiesAction) => onAction(action, () => {
    window.getSelection()?.removeAllRanges(); setSelection(null);
  });
  const actionClass = "h-auto min-h-10 min-w-0 whitespace-normal px-2 py-1.5 text-xs leading-tight @min-[35rem]:min-h-9 @min-[35rem]:whitespace-nowrap";
  return <div className="min-h-0 min-w-0 overflow-y-auto p-3 [scrollbar-gutter:stable]">
    {finding && <div className="mb-2 flex min-h-8 items-center">
      <Button type="button" variant="outline" className="h-8 border-red-300 px-2 text-xs text-red-800"
        onClick={() => onReview(finding.id)}>Review quotation</Button>
    </div>}
    <div ref={surface} contentEditable suppressContentEditableWarning role="textbox" aria-readonly="true"
      aria-multiline="true"
      aria-label={`${footnote ? "Footnote" : "In-text citation"} context`} spellCheck={false}
      onMouseUp={rememberSelection} onKeyUp={rememberSelection}
      onBeforeInput={(event) => event.preventDefault()} onPaste={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()} onKeyDown={(event) => {
        if ((!event.ctrlKey && !event.metaKey && event.key.length === 1) ||
            ["Backspace", "Delete", "Enter"].includes(event.key)) event.preventDefault();
      }} className="h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-gray-300 bg-white px-3 py-12 text-sm leading-6 text-gray-800 outline-none [scrollbar-width:thin] focus-visible:ring-2 focus-visible:ring-red-600 @min-[35rem]:h-32">{highlight(unitText, selected)}</div>
    <div className="mt-2 grid min-h-[5.5rem] grid-cols-2 content-start gap-2">
      <Button type="button" className={actionClass} disabled={busy || !usableSelection(selection)}
        onMouseDown={(event) => event.preventDefault()} onClick={() => selection && submit({
          type: "set-authority-span", occurrenceId: selected.id,
          start: selection.start, end: selection.end })}>Use selection as citation</Button>
      <Button type="button" variant="outline" className={actionClass}
        disabled={busy || !usableSelection(selection)} onMouseDown={(event) => event.preventDefault()}
        onClick={() => selection && submit({ type: "set-pinpoint-span",
          occurrenceId: selected.id, start: selection.start, end: selection.end })}>Use selection as pinpoint</Button>
      <Button type="button" variant="outline" className={actionClass}
        disabled={busy || !footnote || !selection || selection.start !== selection.end ||
          selection.start <= selected.start || selection.start >= selected.end}
        onMouseDown={(event) => event.preventDefault()} onClick={() => selection && submit({
          type: "split-occurrence", occurrenceId: selected.id, cursor: selection.start })}>Split at cursor</Button>
      <Button type="button" variant="outline" className={actionClass}
        disabled={busy || !footnote || !canMerge} onClick={() => submit({
          type: "merge-occurrence", occurrenceId: selected.id })}>Merge with previous</Button>
      <Button type="button" variant="outline" className={cn(actionClass, "col-span-2")} disabled={busy}
        onClick={() => submit({ type: "remove-occurrence",
          occurrenceId: selected.id })}>Not a citation</Button>
    </div>
    {selected.kind === "reference" && <div className="mt-2 grid min-h-16 grid-cols-2 items-center gap-2 border-t border-gray-200 pt-2 @min-[35rem]:flex @min-[35rem]:min-h-12">
      <span className="col-span-2 min-w-0 truncate text-xs text-gray-500 @min-[35rem]:flex-1">
        {linked ? `Linked to ${authorityLabel(linked)}` : "Not linked"}</span>
      <Button type="button" variant="outline" className="h-9 min-w-0 px-2 text-xs"
        disabled={busy} onClick={() => setLinkOpen(true)}><Link2 /> Link to authority</Button>
      <Button type="button" variant="ghost" className="h-9 min-w-0 px-2 text-xs"
        disabled={busy || !selected.reference}
        onClick={() => submit({ type: "set-reference", occurrenceId: selected.id,
          reference: null })}>Clear link</Button>
      <SearchableChoiceModal open={linkOpen} title="Link to authority" size="md"
        searchLabel="Search authorities" value={selected.reference?.targetAuthorityId ?? null}
        className="!h-[min(28rem,calc(100dvh-2rem))]"
        options={authorities.map((item) => ({ value: item.id, label: authorityLabel(item) }))}
        onClose={() => setLinkOpen(false)} onChange={(id) => {
          setLinkOpen(false);
          if (id) submit({ type: "set-reference", occurrenceId: selected.id, reference: {
            kind: /\bibid\b/iu.test(selected.text) ? "ibid" : "supra", targetAuthorityId: id } });
        }} />
    </div>}
  </div>;
}

function BuildPanel({ draft, busy, building, missing, jurisdictionOrder, onAction, sourceIssues,
  outputFreshness, onRelink, onBookFiles, onPickBook, onLibraryBook, sourceLabel, onOpenSource,
  onBuild, onCancel, onDownload }: {
  draft: AuthoritiesProduct; busy: boolean; building: boolean; missing: number;
  outputFreshness: "unbuilt" | "current" | "stale";
  jurisdictionOrder: string[];
  onAction: (action: AuthoritiesAction) => void; onBuild: () => void; onCancel: () => void;
  sourceIssues: Record<string, AuthoritiesSourceIssue>; onRelink: (role: string) => void;
  onBookFiles?: (slot: AuthoritiesBookSlot, files: File[], supplementId?: string) => void;
  onPickBook?: (slot: AuthoritiesBookSlot, multiple: boolean, supplementId?: string) => void;
  onLibraryBook?: (slot: AuthoritiesBookSlot, supplementId?: string) => void;
  sourceLabel?: string;
  onOpenSource?: (role: string) => void;
  onDownload: (documentId: string, versionId: string, filename: string) => void;
}) {
  const [coverOpen, setCoverOpen] = useState(false);
  const profile = authoritiesProfile(draft.state.settings.profileId);
  const manual = draft.state.import.kind === "manual";
  const book = draft.state.outputMode !== "table";
  const filingMedia = profile.options?.filingMedium;
  const bookRoles = profile.options?.bookRole;
  const generatedFederalCover = book && !!profile.requirements?.federalFormatting &&
    !draft.state.bookParts.cover;
  const coverDetailsReady = !generatedFederalCover || completeFederalCover(draft.state.cover);
  const filingRoleReady = !generatedFederalCover || !!draft.state.settings.bookRole;
  const coverReady = coverDetailsReady && filingRoleReady;
  const previousOutput = outputFreshness === "stale";
  const missingText = !coverDetailsReady ? "Add cover details before building."
    : !filingRoleReady ? "Choose who is filing before building."
    : missing ? `${missing} missing PDF${missing === 1 ? "" : "s"}${draft.state.settings.allowIncomplete
      ? ": stub pages will keep their tab slots. Not filing-ready." : "."}`
    : "";
  return <section className="mt-3 rounded-xl border border-gray-300 bg-white p-4 shadow-sm">
    <h2 className="font-semibold text-gray-950">Build outputs</h2>
    <div className={cn("mt-3 grid gap-3 sm:items-end", manual
      ? "sm:grid-cols-[minmax(0,1fr)_9rem]"
      : "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem]")}>
      <AuthoritiesCourtField value={draft.state.settings.profileId} disabled={busy}
        preferredKeys={jurisdictionOrder} bookOnly={manual}
        onChange={(profileId) => onAction({ type: "set-profile", profileId })} />
      {!manual && <SelectField label="Create" value={draft.state.outputMode}
        disabled={busy || !!profile.locked?.outputMode}
        onChange={(outputMode) => onAction({ type: "set-output-mode", outputMode })}
        options={[{ value: "book", label: "Book of Authorities" },
          { value: "table", label: "Table of Authorities" }, { value: "both", label: "Book and Table" }]} />}
      <Button type="button" className="h-10" disabled={busy && !building}
        onClick={building ? onCancel : coverReady ? onBuild : !coverDetailsReady
          ? () => setCoverOpen(true)
          : () => document.getElementById("authorities-filed-by")?.focus()}>
        {building ? <><Loader2 className="motion-safe:animate-spin" /> Cancel</>
          : <><BookOpen /> {draft.state.settings.allowIncomplete ? "Build draft" : "Build"}</>}</Button>
    </div>
    {book && filingMedia && bookRoles && <div className="mt-2 grid gap-3 sm:grid-cols-2">
      <SelectField label="Filing" value={draft.state.settings.filingMedium ?? "electronic"}
        disabled={busy} onChange={(filingMedium) => onAction({ type: "set-settings",
          settings: { filingMedium } })}
        options={filingMedia} />
      <SelectField label="Filed by" value={draft.state.settings.bookRole ?? ""}
        placeholder={draft.state.settings.bookRole ? null : "Choose filing party"}
        disabled={busy} onChange={(bookRole) => onAction({ type: "set-settings",
          settings: { bookRole } })} options={bookRoles} />
    </div>}
    <p className={cn("mt-2 min-h-5 text-sm leading-5", missingText ? "text-red-800" : "invisible")}
      aria-hidden={!missingText || undefined}>{missingText || "Ready"}</p>
    {book && <BookContents draft={draft} busy={busy} onAction={onAction}
      sourceIssues={sourceIssues} onRelink={onRelink} onFiles={onBookFiles} onPick={onPickBook}
      onLibrary={onLibraryBook} sourceLabel={sourceLabel}
      onOpen={onOpenSource} federalCoverComplete={coverReady}
      onEditFederalCover={generatedFederalCover ? () => setCoverOpen(true) : undefined} />}
    <details className="group border-t border-gray-200 pt-2">
      <summary className="flex min-h-9 w-fit cursor-pointer list-none items-center gap-1 rounded-md px-1 text-sm font-medium text-red-700 outline-none hover:text-red-900 focus-visible:ring-2 focus-visible:ring-red-600 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" /> Options</summary>
      <div className="grid gap-3 pb-2 pt-3 sm:grid-cols-2">
        {draft.state.import.kind === "document" && draft.state.outputMode !== "table" && <SelectField label="Source handling" value={draft.state.settings.sourceMode}
          disabled={busy} onChange={(sourceMode) => onAction({ type: "set-settings", settings: { sourceMode } })}
          options={SOURCE_OPTIONS} />}
        {draft.state.import.kind === "document" && draft.state.outputMode !== "table" && <SelectField label="Passage marking" value={draft.state.settings.passageMarking}
          disabled={busy} onChange={(passageMarking) => onAction({ type: "set-settings", settings: { passageMarking } })}
          options={passageOptions(profile.id)} />}
        {draft.state.outputMode !== "table" && <SelectField label="Tabs" value={draft.state.settings.tabStyle}
          disabled={busy} onChange={(tabStyle) => onAction({ type: "set-settings", settings: { tabStyle } })}
          options={[{ value: "numeric", label: "Numbers" }, { value: "alpha", label: "Letters" }]} />}
        {draft.state.import.kind === "document" && draft.state.outputMode !== "book" && <SelectField label="Table order" value={draft.state.settings.tableOrder}
          disabled={busy} onChange={(tableOrder) => onAction({ type: "set-settings", settings: { tableOrder } })}
          options={[{ value: "alphabetical", label: "Alphabetical" },
            { value: "first-reference", label: "First reference" }]} />}
        {book && profile.options?.missingSourcePolicy && <SelectField label="Missing sources" value={draft.state.settings.missingSourcePolicy}
          disabled={busy} onChange={(missingSourcePolicy) => onAction({ type: "set-settings",
            settings: { missingSourcePolicy } })}
          options={[{ value: "placeholder", label: "Add labelled pages" },
            { value: "omit", label: "Leave out of book" }]} />}
        {draft.state.import.kind === "document" && draft.state.outputMode !== "book" && <SelectField label="Word table" value={draft.state.settings.tableDelivery}
          disabled={busy} onChange={(tableDelivery) => onAction({ type: "set-settings", settings: { tableDelivery } })}
          options={[{ value: "native-append", label: "Append a native table" },
            { value: "linked-append", label: "Append a linked table" },
            { value: "native-marks", label: "Mark citations in a Word copy" }]} />}
        {draft.state.import.kind === "document" && draft.state.outputMode !== "book" && <SelectField label="Table locations" value={draft.state.settings.tableLocation}
          disabled={busy} onChange={(tableLocation) => onAction({ type: "set-settings", settings: { tableLocation } })}
          options={[{ value: "pages", label: "Pages" }, { value: "pinpoints", label: "Pinpoints" },
            { value: "combined", label: "Pages and pinpoints" }]} />}
        {draft.state.import.kind === "document" && draft.state.outputMode !== "table" && <SelectField label="Scanned PDFs" value={draft.state.settings.scannedPdfPolicy}
          disabled={busy} onChange={(scannedPdfPolicy) => onAction({ type: "set-settings", settings: { scannedPdfPolicy } })}
          options={[{ value: "page-margin", label: "Keep scan; mark cited pages" },
            { value: "cited-pages", label: "OCR cited pages" },
            { value: "full", label: "OCR every page" }]} />}
        {draft.state.import.kind === "document" && draft.state.import.fileType === "docx" &&
          draft.state.outputMode !== "book" &&
          <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md text-sm text-gray-800 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red-600">
            <input type="checkbox" className="h-4 w-4 accent-red-700" disabled={busy}
              checked={draft.state.insertIntoDocument} onChange={(event) => onAction({
                type: "set-document-output", enabled: event.target.checked })} />
            Add the table to a Word copy
          </label>}
      </div>
    </details>
    <div className="min-h-12 border-t border-gray-200 pt-2">
      {!!Object.keys(draft.outputs).length && <p className={cn(
        "mb-1 min-h-5 text-xs leading-5 text-gray-600",
        !previousOutput && "invisible",
      )}>{previousOutput ? "Previous build — rebuild to update" : "Current build"}</p>}
      {Object.entries(draft.outputs).map(([role, output]) => <button key={role} type="button"
        aria-label={`Download ${previousOutput ? "previous " : ""}${output.filename}`}
        title={output.filename}
        onClick={() => onDownload(output.documentId, output.versionId, output.filename)}
        className="grid min-h-10 w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600 disabled:opacity-50">
        <Download className="h-4 w-4 text-red-700" />
        <span className="font-medium text-gray-900">{previousOutput && "Previous "}{role === "table" ? "Table"
          : role.startsWith("book") ? "Book"
            : output.filename.toLowerCase().endsWith(".pdf") ? "Filing PDF" : "Word copy"}</span>
        <span className="min-w-0 truncate text-gray-500">{output.filename}</span>
        <span className="text-[11px] uppercase text-gray-500">{output.filename.split(".").at(-1)}</span>
      </button>)}
    </div>
    {coverOpen && <FederalCoverModal cover={draft.state.cover} profileId={profile.id}
      busy={busy} onClose={() => setCoverOpen(false)} onSave={(cover) => {
        setCoverOpen(false); onAction({ type: "set-cover", cover });
      }} />}
  </section>;
}

const completeFederalCover = (cover: AuthoritiesCover) => !!cover.courtFileNumber.trim() &&
  cover.partyGroups.length >= 2 && cover.partyGroups.every(({ role, parties }) =>
    !!role.trim() && parties.some((party) => !!party.trim()));

function FederalCoverModal({ cover, profileId, busy, onClose, onSave }: {
  cover: AuthoritiesCover; profileId: AuthoritiesProfileId; busy: boolean;
  onClose: () => void; onSave: (cover: AuthoritiesCover) => void;
}) {
  const roles = profileId === "federal-court"
    ? ["Applicant", "Respondent"] : ["Appellant", "Respondent"];
  const [value, setValue] = useState<AuthoritiesCover>(() => ({ ...structuredClone(cover),
    partyGroups: cover.partyGroups.length ? structuredClone(cover.partyGroups)
      : roles.map((role) => ({ role, parties: [""] })) }));
  const group = (index: number, patch: Partial<AuthoritiesCover["partyGroups"][number]>) =>
    setValue((current) => ({ ...current, partyGroups: current.partyGroups.map((item, position) =>
      position === index ? { ...item, ...patch } : item) }));
  return <Modal open onClose={onClose} breadcrumbs={["Cover details"]} size="xl"
    primaryAction={{ label: "Save cover", type: "submit", form: "authorities-cover-form",
      disabled: busy }}>
    <form id="authorities-cover-form" className="grid gap-4 pb-5" onSubmit={(event) => {
      event.preventDefault(); onSave({ ...value,
        courtFileNumber: value.courtFileNumber.trim(),
        applicationUnder: value.applicationUnder.trim(), title: value.title.trim(),
        partyGroups: value.partyGroups.map(({ role, parties }) => ({ role: role.trim(),
          parties: parties.map((party) => party.trim()).filter(Boolean) })) });
    }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium text-gray-700">Court file number
          <Input autoFocus required value={value.courtFileNumber}
            onChange={(event) => setValue({ ...value, courtFileNumber: event.target.value })}
            className="mt-1.5 h-10 border-gray-400 md:text-base" />
        </label>
        <label className="text-sm font-medium text-gray-700">Title <span className="font-normal text-gray-500">(optional)</span>
          <Input value={value.title}
            onChange={(event) => setValue({ ...value, title: event.target.value })}
            className="mt-1.5 h-10 border-gray-400 md:text-base" />
        </label>
      </div>
      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-gray-900">Parties</legend>
        {value.partyGroups.map(({ role, parties }, index) => <section key={index}
          aria-label={`Party group ${index + 1}`}
          className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <label className="text-sm font-medium text-gray-700">Role
            <Input required value={role} onChange={(event) => group(index,
              { role: event.target.value })} className="mt-1 h-9 border-gray-400 bg-white md:text-base" />
          </label>
          <label className="mt-3 block text-sm font-medium text-gray-700">Party names
            <span className="ml-1 font-normal text-gray-500">(one per line)</span>
            <textarea required rows={2} value={parties.join("\n")}
              onChange={(event) => group(index, { parties: event.target.value.split(/\r?\n/u) })}
              className="mt-1 min-h-20 w-full resize-y rounded-md border border-gray-400 bg-white px-3 py-2 text-base text-gray-950 outline-none focus-visible:ring-2 focus-visible:ring-red-600" />
          </label>
          {value.partyGroups.length > 2 && <Button type="button" variant="ghost"
            className="mt-1 h-8 px-2 text-xs" onClick={() => setValue((current) => ({
              ...current, partyGroups: current.partyGroups.filter((_, position) => position !== index),
            }))}>Remove role</Button>}
        </section>)}
      </fieldset>
      <Button type="button" variant="outline" className="h-9 w-fit" onClick={() =>
        setValue((current) => ({ ...current,
          partyGroups: [...current.partyGroups, { role: "", parties: [""] }] }))}>
        <Plus /> Add role
      </Button>
      <label className="text-sm font-medium text-gray-700">Application under <span className="font-normal text-gray-500">(optional)</span>
        <Input value={value.applicationUnder}
          onChange={(event) => setValue({ ...value, applicationUnder: event.target.value })}
          className="mt-1.5 h-10 border-gray-400 md:text-base" />
      </label>
    </form>
  </Modal>;
}

function BookContents({ draft, busy, onAction, sourceIssues, onRelink, onFiles, onPick, onLibrary,
  sourceLabel = "Library", onOpen,
  federalCoverComplete, onEditFederalCover }: {
  draft: AuthoritiesProduct; busy: boolean; onAction: (action: AuthoritiesAction) => void;
  sourceIssues: Record<string, AuthoritiesSourceIssue>; onRelink: (role: string) => void;
  onFiles?: (slot: AuthoritiesBookSlot, files: File[], supplementId?: string) => void;
  onPick?: (slot: AuthoritiesBookSlot, multiple: boolean, supplementId?: string) => void;
  onLibrary?: (slot: AuthoritiesBookSlot, supplementId?: string) => void;
  sourceLabel?: string;
  onOpen?: (role: string) => void;
  federalCoverComplete?: boolean;
  onEditFederalCover?: () => void;
}) {
  const add = (slot: AuthoritiesBookSlot, multiple: boolean, supplementId?: string) => onPick
    ? onPick(slot, multiple, supplementId) : undefined;
  const supplementStart = planAuthorities(draft)
    .filter(({ tab }) => tab !== "Not reproduced").length;
  return <div className="mb-2 border-t border-gray-200 pt-3">
    <h3 className="mb-2 min-h-8 text-sm font-semibold leading-8 text-gray-900">Cover and index</h3>
    <div className="divide-y divide-gray-200 rounded-lg border border-gray-300">
      {(["cover", "index"] as const).map((slot) => {
        const part = draft.state.bookParts[slot], issue = part ? sourceIssues[part.bindingRole] : undefined;
        const title = slot === "cover" ? "Cover" : "Index";
        return <div key={slot}
          className="grid min-h-11 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1 px-2 py-1 sm:grid-cols-[4.25rem_minmax(0,1fr)_auto] sm:gap-2 sm:py-0">
          <span className="text-sm font-medium text-gray-900">{title}</span>
          <span className="min-w-0 truncate text-xs text-gray-600" title={part?.filename}>
            {part?.filename ?? (slot === "cover" && onEditFederalCover && !federalCoverComplete
              ? "Details required" : "Generated")}</span>
          <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
            {slot === "cover" && !part && onEditFederalCover && <Button type="button"
              variant="outline" className="h-8 px-2 text-xs" disabled={busy}
              onClick={onEditFederalCover}>{federalCoverComplete ? "Edit" : "Add details"}</Button>}
            {part && onOpen && <Button type="button" variant="ghost" className="h-8 px-2 text-xs"
              disabled={busy} onClick={() => onOpen(part.bindingRole)}><Eye /> Open</Button>}
            {part && relinkable(issue) ? <Button type="button" variant="outline" className="h-8 px-2 text-xs text-red-800"
              disabled={busy} onClick={() => onRelink(part.bindingRole)}>{sourceAction(issue, "file")}</Button>
              : onPick ? <Button type="button" variant="outline" className="h-8 px-2 text-xs"
              disabled={busy} onClick={() => add(slot, false)}>{part ? "Replace" : "Add file"}</Button>
              : onFiles && <FileInputButton multiple={false} disabled={busy}
                label={part ? "Replace" : "Add file"} accept=".pdf,application/pdf"
                onFiles={(files) => onFiles(slot, files)} variant="outline" compact />}
            {onLibrary && <Button type="button" variant="outline" className="h-8 px-2 text-xs"
              aria-label={`Choose ${title} from ${sourceLabel}`} disabled={busy}
              onClick={() => onLibrary(slot)}><FolderSearch /> {sourceLabel}</Button>}
            {part && <MoreActionsMenu label={`${title} options`} items={[{ label: "Use generated",
              disabled: busy, onSelect: () => onAction({ type: "clear-book-part", slot }) }]} />}
          </div>
        </div>;
      })}
    </div>
    <div className="mt-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold text-gray-900">Other book PDFs</h3>
      <div className="flex flex-wrap justify-end gap-1">
        {onPick ? <Button type="button" variant="outline" className="h-8 border-gray-400 px-2.5 text-xs"
          aria-label="Add other book files" disabled={busy} onClick={() => add("supplemental", true)}>
          <FilePlus2 /> Add files</Button>
          : onFiles && <FileInputButton multiple disabled={busy} label="Add files"
            ariaLabel="Add other book files" accept=".pdf,application/pdf"
            onFiles={(files) => onFiles("supplemental", files)} variant="outline" compact />}
        {onLibrary && <Button type="button" variant="outline" className="h-8 border-gray-400 px-2.5 text-xs"
          aria-label={`Add another book PDF from ${sourceLabel}`} disabled={busy}
          onClick={() => onLibrary("supplemental")}><FolderSearch /> {sourceLabel}</Button>}
      </div>
    </div>
    {!!draft.state.bookParts.supplements.length && <div
      className="mt-1 divide-y divide-gray-200 rounded-lg border border-gray-300">
      {draft.state.bookParts.supplements.map((part, index) => {
        const issue = sourceIssues[part.bindingRole];
        return <div key={part.id}
          className="grid min-h-11 grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-1 px-2 py-1 sm:grid-cols-[4.25rem_minmax(0,1fr)_auto] sm:gap-2 sm:py-0">
          <span className="text-xs font-semibold uppercase tabular-nums text-gray-500">
            {tabLabel(supplementStart + index + 1, draft.state.settings.tabStyle, draft.state.settings)}</span>
          <span className="min-w-0 truncate text-sm text-gray-800" title={part.filename}>
            {part.filename}</span>
          <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
            {onOpen && <Button type="button" variant="ghost" className="h-8 px-2 text-xs"
              disabled={busy} onClick={() => onOpen(part.bindingRole)}><Eye /> Open</Button>}
            {relinkable(issue) && <Button type="button" variant="ghost"
              className="h-8 px-2 text-xs text-red-800" disabled={busy}
              onClick={() => onRelink(part.bindingRole)}>{sourceAction(issue, "file")}</Button>}
            {onPick ? <Button type="button" variant="outline" className="h-8 px-2 text-xs"
              disabled={busy} onClick={() => add("supplemental", false, part.id)}>Replace</Button>
              : onFiles && <FileInputButton multiple={false} disabled={busy} label="Replace"
                accept=".pdf,application/pdf" onFiles={(files) => onFiles("supplemental", files, part.id)}
                variant="outline" compact />}
            {onLibrary && <Button type="button" variant="outline" className="h-8 px-2 text-xs"
              aria-label={`Replace ${part.filename} from ${sourceLabel}`} disabled={busy}
              onClick={() => onLibrary("supplemental", part.id)}><FolderSearch /> {sourceLabel}</Button>}
            <MoreActionsMenu label={`${part.filename} options`} items={[{
              label: "Remove from book", disabled: busy,
              onSelect: () => onAction({ type: "remove-book-supplement", id: part.id }),
            }]} />
          </div>
        </div>;
      })}
    </div>}
  </div>;
}

function AuthorityDetailsModal({ open, busy, authority, onClose, onSave }: {
  open: boolean; busy: boolean; authority?: AuthorityIdentity; onClose: () => void;
  onSave: (kind: AuthorityKind, citation: string, name: string | null) => void;
}) {
  const [citation, setCitation] = useState(authority?.citation ?? "");
  const [name, setName] = useState(authority ? authorityName(authority) : "");
  const [kind, setKind] = useState<AuthorityKind>(authority?.kind ?? "case");
  const submit = () => {
    if (!citation.trim()) return;
    onSave(kind, citation.trim(), name.trim() || null);
    if (!authority) { setCitation(""); setName(""); setKind("case"); }
  };
  const action = authority ? "Save" : "Add";
  return <Modal open={open} onClose={onClose} size="md"
    breadcrumbs={[authority ? "Edit authority" : "Add authority"]}
    fit
    primaryAction={{ label: action, disabled: busy || !citation.trim(), onClick: submit }}>
    <div className="grid gap-4 pb-5">
      <SelectField label="Type" value={kind} onChange={setKind}
        options={[{ value: "case", label: "Case" }, { value: "legislation", label: "Legislation" },
          { value: "commentary", label: "Commentary" }, { value: "other", label: "Other" }]} />
      <label className="text-sm font-medium text-gray-800">Citation
        <Input autoFocus value={citation} onChange={(event) => setCitation(event.target.value)}
          onKeyDown={(event) => event.key === "Enter" && submit()}
          className="mt-1 h-10 border-gray-400 md:text-base" /></label>
      <label className="text-sm font-medium text-gray-800">Displayed title <span className="font-normal text-gray-500">(optional)</span>
        <Input value={name} onChange={(event) => setName(event.target.value)}
          className="mt-1 h-10 border-gray-400 md:text-base" /></label>
    </div>
  </Modal>;
}

type CardOption<T extends string> = { value: T; label: string; detail?: string;
  preview?: AuthoritiesBuildSettings["passageMarking"] };
function OptionCards<T extends string>({ legend, value, options, onChange, columns, disabled,
  className }: { legend: string; value: T; options: ReadonlyArray<CardOption<T>>;
  onChange: (value: T) => void; columns?: boolean; disabled?: boolean; className?: string }) {
  return <fieldset className={className} disabled={disabled}>
    <legend className="mb-2 text-sm font-semibold text-gray-950">{legend}</legend>
    <div className={cn("grid auto-rows-fr gap-2", columns && "sm:grid-cols-2")}>
      {options.map((option) => <label key={option.value}
        className="grid min-h-16 cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-3 rounded-lg border border-gray-300 p-3 has-[:checked]:border-red-600 has-[:checked]:bg-red-50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red-600 has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
        <input type="radio" name={`authorities-${legend}`} value={option.value}
          checked={value === option.value} onChange={() => onChange(option.value)}
          className="h-4 w-4 accent-red-700" />
        {option.preview && <MarkPreview type={option.preview} />}
        <span className={cn("min-w-0", !option.preview && "col-span-2")}>
          <span className="block text-sm font-semibold text-gray-950">{option.label}</span>
          {option.detail && <span className="mt-0.5 block text-xs leading-4 text-gray-600">
            {option.detail}</span>}
        </span>
      </label>)}
    </div>
  </fieldset>;
}

function MarkPreview({ type }: { type: AuthoritiesBuildSettings["passageMarking"] }) {
  return <span aria-hidden="true" className={cn(
    "relative block h-9 w-14 shrink-0 overflow-hidden rounded border border-gray-400 bg-white",
    type === "margin" && "border-l-[3px] border-l-red-700",
    type === "sidelined" && "border-l-[3px] border-l-gray-950",
  )}>
    {type === "paragraph" && <span className="absolute inset-x-1.5 top-2.5 h-4 bg-red-100" />}
    {(type === "margin" || type === "text") &&
      <span className="absolute left-2 top-[15px] h-1.5 w-5 bg-red-200" />}
    {[8, 17, 26].map((top, index) => <span key={top}
      className={cn("absolute left-2 h-0.5 bg-gray-500", index === 1 ? "w-9" : "w-7")}
      style={{ top }} />)}
  </span>;
}

function SelectField<T extends string>({ label, value, options, onChange, disabled, className,
  placeholder = null }: {
  label: string; value: T | ""; options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void; disabled?: boolean; className?: string;
  placeholder?: string | null;
}) {
  return <label className={cn("block min-w-0 text-sm font-medium text-gray-800", className)}>{label}
    <ModalSelect id={`authorities-${label.toLowerCase().replaceAll(" ", "-")}`}
      value={value} disabled={disabled} onChange={(next) => next && onChange(next as T)}
      placeholder={placeholder} className="mt-1" options={options} />
  </label>;
}


function Status({ busy, busyText, status, error }: { busy: boolean; busyText: string;
  status: string; error: boolean }) {
  const visible = (busy && !!busyText) || !!status;
  return <p className={cn("mb-1 flex min-h-6 items-center px-1 text-sm",
    visible && "font-medium",
    error ? "text-red-800" : "text-gray-600")}
    role="status" aria-live="polite" aria-atomic="true" aria-busy={busy || undefined}>
    {visible && <span className="mr-2 grid size-4 shrink-0 place-items-center" aria-hidden="true">
      {busy && <Loader2 className="size-4 motion-safe:animate-spin" />}
    </span>}
    {busy ? status || busyText : status}
  </p>;
}
/** Operations a step owns: their progress belongs in that step, not at the top of the page. */
const STEP_PROGRESS = new Set(["Finding source PDFs", "Checking source PDFs"]);
const STEPS = [{ value: "citations", label: "Citations" }, { value: "sources", label: "Sources" },
  { value: "highlights", label: "Highlights" }, { value: "build", label: "Build book" }] as const;
type Step = typeof STEPS[number]["value"];

const SOURCE_OPTIONS: ReadonlyArray<CardOption<AuthoritiesBuildSettings["sourceMode"]>> = [
  { value: "automatic", label: "Automatic sources",
    detail: "Use available original PDFs and rebuild anything missing from source text." },
  { value: "manual-originals", label: "Use available original PDFs and manually add the PDFs myself for the rest",
    detail: "Keep missing sources open for PDFs you attach." },
  { value: "render", label: "Rebuild all sources from text (where available)",
    detail: "Create consistent pages from the available source text." },
];
const PASSAGE_OPTIONS: ReadonlyArray<CardOption<AuthoritiesBuildSettings["passageMarking"]>> = [
  { value: "margin", label: "Paragraph line and exact quote", preview: "margin",
    detail: "Mark the cited paragraph at the margin and highlight matching quoted words." },
  { value: "sidelined", label: "Black paragraph line", preview: "sidelined",
    detail: "Add a vertical line beside the cited paragraph." },
  { value: "paragraph", label: "Highlight cited paragraph", preview: "paragraph",
    detail: "Highlight the full resolved paragraph." },
  { value: "text", label: "Highlight exact quotes", preview: "text",
    detail: "Highlight matching quoted words only." },
  { value: "none", label: "No passage marks", preview: "none",
    detail: "Leave source pages unmarked." },
];
const MARKED_PASSAGE_OPTIONS = PASSAGE_OPTIONS.filter(({ value }) => value !== "none");
const passageOptions = (profileId: AuthoritiesProfileId) =>
  authoritiesProfile(profileId).requirements?.markedPassages ? MARKED_PASSAGE_OPTIONS : PASSAGE_OPTIONS;
const withProfile = (value: StartPreferences, profileId: AuthoritiesProfileId): StartPreferences =>
  ({ ...value, profileId, passageMarking: authoritiesProfile(profileId).requirements?.markedPassages &&
    value.passageMarking === "none" ? "margin" : value.passageMarking });

function missingSources(draft: AuthoritiesProduct) {
  return planAuthorities(draft).map(({ id }) => draft.state.authorities[id])
    .filter((item) => !item.excluded &&
      missingSource(draft.state, item, draft.state.stage !== "citations"));
}
function orderedOccurrences(draft?: AuthoritiesProduct) {
  if (!draft) return [];
  return draft.state.units.flatMap((unit) => unit.occurrenceIds
    .flatMap((id) => draft.state.occurrences[id] ? [draft.state.occurrences[id]] : []));
}
function discrepancyKey(draft?: AuthoritiesProduct) {
  if (!draft || draft.state.import.kind !== "document") return "";
  const { authorities, discrepancyDecisions, occurrences, units } = draft.state;
  const footnotes = new Set(units.filter(({ kind }) => kind === "footnote").map(({ id }) => id));
  if (!Object.values(occurrences).some(({ authorityId, pinpoints, unitId }) => authorityId &&
      footnotes.has(unitId) && pinpoints.length === 1 &&
      authorities[authorityId]?.sourceIdentity?.provider === "a2aj")) return "";
  return JSON.stringify([
    units.map(({ id, kind, ordinal, footnoteId, footnoteRefs, text, occurrenceIds }) =>
      [id, kind, ordinal, footnoteId, footnoteRefs, text, occurrenceIds]),
    Object.keys(occurrences).sort().map((id) => {
      const { unitId, authorityId, pinpoints, citation } = occurrences[id];
      return [id, unitId, authorityId, pinpoints, citation];
    }),
    Object.keys(authorities).sort().map((id) => {
      const { kind, citation, name, sourceIdentity } = authorities[id];
      return [id, kind, citation, name, sourceIdentity];
    }),
    discrepancyDecisions,
  ]);
}
function metadata({ state: _state, ...item }: AuthoritiesProduct) { return item; }
const sourceIssueKey = (draft?: AuthoritiesProduct) => draft
  ? canonicalJson([draft.id, draft.state.bindings]) : "";
function highlight(text: string, occurrence: AuthorityOccurrence) {
  const spans = [occurrence.authoritySpan, occurrence.pinpointSpan].filter((span): span is NonNullable<typeof span> =>
    !!span && span.start >= 0 && span.end > span.start && span.end <= text.length)
    .sort((a, b) => a.start - b.start);
  if (!spans.length) return text;
  const boundaries = [...new Set([0, text.length, ...spans.flatMap(({ start, end }) =>
    [start, end])])].sort((a, b) => a - b), nodes: ReactNode[] = [];
  for (let index = 0; index < boundaries.length - 1; index += 1) {
    const start = boundaries[index], end = boundaries[index + 1],
      authority = start < occurrence.authoritySpan.end && occurrence.authoritySpan.start < end,
      pinpoint = !!occurrence.pinpointSpan && start < occurrence.pinpointSpan.end &&
        occurrence.pinpointSpan.start < end, value = text.slice(start, end);
    nodes.push(authority || pinpoint ? <mark key={`${start}:${end}`}
      data-authority-span={authority || undefined} data-pinpoint-span={pinpoint || undefined}
      className={cn("rounded px-0.5 text-inherit", pinpoint ? "bg-red-200" : "bg-red-100")}>
      {value}</mark> : value);
  }
  return <>{nodes}</>;
}
function location(item: AuthorityOccurrence, index: number, all: AuthorityOccurrence[],
  units: AuthoritiesProduct["state"]["units"]) {
  const unit = units.find(({ id }) => id === item.unitId);
  if (unit?.kind === "footnote") return `Footnote ${unit.footnoteId ?? unit.ordinal + 1}`;
  const body = all.slice(0, index + 1).filter(({ unitId }) =>
    units.some(({ id, kind }) => id === unitId && kind === "body")).length;
  return `In-text citation ${body}`;
}
function planAuthorities(draft: AuthoritiesProduct) {
  const state = draft.state;
  return deriveAuthorityProcedure(authorityProcedureInput(state, {
    purpose: state.outputMode === "table" ? "table" : "book",
    reproduced: (item) => !item.excluded && (item.source.kind === "attached" ||
      state.settings.missingSourcePolicy === "placeholder"),
  }));
}
function selectionRange(root: HTMLElement | null) {
  const selection = window.getSelection();
  if (!root || !selection || selection.rangeCount !== 1) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const prefix = document.createRange(); prefix.selectNodeContents(root);
  prefix.setEnd(range.startContainer, range.startOffset); const start = prefix.toString().length;
  prefix.setEnd(range.endContainer, range.endOffset); const end = prefix.toString().length;
  return { start: Math.min(start, end), end: Math.max(start, end) };
}
function usableSelection(value: { start: number; end: number } | null) {
  return !!value && value.start !== value.end;
}
const errorText = (error: unknown) => errorMessage(error, "Authorities could not be updated.");
const lastDraftKey = (projectId?: string) =>
  `beaver.authorities.last.${projectId ?? "library"}`;
function loadPreferences(): StartPreferences {
  try {
    const value = JSON.parse(localStorage.getItem("beaver.authorities.preferences") ?? "null") as
      Partial<StartPreferences> | null;
    return value && AUTHORITY_PROFILE_BY_ID.has(value.profileId ?? "") &&
      ["automatic", "manual-originals", "render"].includes(value.sourceMode ?? "") &&
      PASSAGE_OPTIONS.some(({ value: id }) => id === value.passageMarking)
      ? withProfile(value as StartPreferences, value.profileId!) : DEFAULTS;
  } catch { return DEFAULTS; }
}
