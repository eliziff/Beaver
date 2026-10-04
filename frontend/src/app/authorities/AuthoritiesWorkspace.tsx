import { autoFetchToast } from "../../../../shared/auto-fetch-toast.mjs";
import { CitationReview } from "./CitationReview";
import { holds, previewEdit, reviewStep, savedIds, type ReviewStep } from "./reviewEdits";
import { QuotationReview } from "./QuotationFinding";
import { StepProgress } from "./StepSection";
import { FileInputButton } from "./FileInputButton";
import { authorityName, authorityLabel, authorityCitationLine, authorityCitationText,
  requiresBilingualSources, requiresPdf,
  missingSource, relinkable } from "./authorityPresentation";
import { BookOpen, ChevronRight, Eye, FileCheck2, FilePlus2, FileType2, FileX2, FolderSearch, LockKeyhole,
  History, Loader2, Plus, Scale, Settings2, SlidersHorizontal, Upload } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState,
  type ComponentType, type ReactNode } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { pdfOpening } from "@/app/lib/inspectPdf";
import { ModalSelect, SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
import { WorkspaceHeader } from "@/app/components/shared/WorkspaceHeader";
import { OutputFolderSetting } from "@/app/components/shared/OutputFolderSetting";
import { MoreActionsMenu } from "@/app/components/shared/MoreActionsMenu";
import type { Document, PdfRecognizedText } from "@/app/lib/api/documents";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { TabList } from "@/app/components/ui/tabs";
import { Pagination } from "@/app/components/shared/TablePrimitive";
import { downloadBlob } from "@/app/lib/download";
import { cn, errorMessage, formatDateTime } from "@/app/lib/utils";
import type { WorkProductFocus, WorkProductMetadata,
  WorkProductRefresh } from "@/app/lib/workProducts";
import { rowControl, Sources, type BookFiles } from "./AuthoritySources";
import { AuthoritiesOutputOptions, briefPdfAdvice, FinalPdfOptions, type AuthoritiesOutputOptionsValue } from "./AuthoritiesOutputOptions";
import { FileCard, OptionCard, OptionCards } from "./OptionCards";
import { OutputCards, OutputOptions, type OutputCard } from "./OutputCards";
import { AuthoritiesCourtField, BookFrontModal, completeFederalCover, coverForm } from "./BookFront";
import { ImportWizard, SOURCE_OPTIONS, SourceChoices, type Remembered } from "./ImportWizard";
import { courtChange } from "./courtChange";
import { PdfCanvas } from "@/app/components/shared/views/PdfCanvas";
import { useScannedSources, useSourceOcr } from "./sourceOcr";
import type { AuthoritiesBookSlot, AuthoritiesFile, AuthoritiesHost,
  AuthoritiesLibraryPdfTarget,
  AuthoritiesSourceIssue } from "./host";
import { AUTHORITY_PROFILE_BY_ID, authoritiesProfile } from "./profiles";
import type { AuthoritiesAction, AuthoritiesBuildReceipt, AuthoritiesBuildSettings, AuthoritiesProduct,
  AuthoritiesDiscrepancy, AuthoritiesDiscrepancyAction, AuthoritiesProfileId,
  AuthorityIdentity, AuthorityKind, AuthoritySourceLanguage } from "./types";
import { authorityProcedureInput, deriveAuthorityProcedure, tabLabel } from "../../../../shared/authorities-order.mjs";
import { authoritiesInputPlan, authorityReproducedInBook } from "../../../../shared/authorities-sources.mjs";
import { canonicalJson } from "../../../../shared/canonical-json.mjs";

import { AuthoritiesHighlights, PASSAGE_OPTIONS, useHighlightsAhead } from "./AuthoritiesHighlightEditor";
import { useStatuteCopies } from "./statuteExcerpts";

type WorkspaceTab = "automatic" | "manual" | "drafts";
type StartPreferences = Remembered;
/** A brief being imported: read, and its sources found, while the import's choices are made. */
type PendingImport = { title: string; finishing: boolean; error: string };
const TABS: ReadonlyArray<{ value: WorkspaceTab; label: string }> = [
  { value: "automatic", label: "Automatic" }, { value: "manual", label: "Manual" },
  { value: "drafts", label: "Drafts" },
];
// Every view, the citation review among them, and the header and steps above it share one
// readable frame, so nothing moves between them and a document page shows at about its own size.
const FRAME = "mx-auto w-full max-w-[68rem] px-4 sm:px-6 md:mx-auto";
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
const bookPreferences = ({ profileId, sourceMode, passageMarking }: StartPreferences): StartPreferences =>
  withProfile({ profileId, sourceMode, passageMarking },
    authoritiesProfile(profileId).locked?.outputMode === "table" ? GENERAL_PROFILE.id : profileId);
export type AuthoritiesDocumentPickerProps = {
  open: boolean; title: string; busy?: boolean; projectId?: string;
  formats: readonly ("pdf" | "docx")[];
  onSelect: (document: Document) => void; onClose: () => void;
};
type LibraryPicker = ComponentType<AuthoritiesDocumentPickerProps>;

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
type ActionHandler = (action: AuthoritiesAction,
  done?: (next: AuthoritiesProduct) => void | Promise<void>) => void;
type DiscrepancyHandler = (finding: AuthoritiesDiscrepancy,
  action: AuthoritiesDiscrepancyAction, done: () => void) => void;

export function AuthoritiesWorkspace({ host, headerActions, onDraftChange, initialDraftId,
  onFocusChange, refreshToken, locked = false, LibraryPicker, projectId, jurisdictionOrder = [],
  initialNewDraft = false, onInitialConsumed }: {
  host: AuthoritiesHost;
  headerActions?: ReactNode;
  onDraftChange?: (draft: AuthoritiesProduct | undefined, synced: boolean) => void;
  onFocusChange?: (focus?: WorkProductFocus) => void;
  refreshToken?: WorkProductRefresh;
  initialDraftId?: string;
  projectId?: string;
  locked?: boolean;
  LibraryPicker?: LibraryPicker;
  jurisdictionOrder?: string[];
  /** A workflow launch asks for a fresh draft instead of the remembered one. */
  initialNewDraft?: boolean;
  onInitialConsumed?: () => void;
}) {
  const requested = initialDraftId ?? "";
  const routeRequest = useRef(0);
  const [tab, setTab] = useState<WorkspaceTab>("automatic");
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const globalTab = tab === "drafts";
  const [preferences, setPreferences] = useState(loadPreferences);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualTitle, setManualTitle] = useState("Book of Authorities");
  const [drafts, setDrafts] = useState<WorkProductMetadata[]>([]);
  // The drafts list is loading until it has been listed for this host and project.
  const [draftsListedFor, setDraftsListedFor] = useState<{ host: AuthoritiesHost; projectId?: string }>();
  const draftsLoading = draftsListedFor?.host !== host || draftsListedFor.projectId !== projectId;
  const [restoredScope, setRestoredScope] = useState("");
  const [draft, setDraft] = useState<AuthoritiesProduct>();
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(!!requested), [running, setBusy] = useState(false);
  const [pendingActions, setPendingActions] = useState(0);
  const busy = running || pendingActions > 0;
  const runningRef = useRef(false);
  const [operation, setOperation] = useState("");
  const [building, setBuilding] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  const [stepFailure, setStepFailure] = useState("");
  const [libraryTarget, setLibraryTarget] = useState<LibraryTarget>(), [addOpen, setAddOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport>();
  const importRequest = useRef(0), staged = useRef<Promise<AuthoritiesProduct | undefined>>(Promise.resolve(undefined));
  const [pendingAttachment, setPendingAttachment] = useState<{
    authorityId: string; selected: PdfChoice;
  }>();
  const [findingId, setFindingId] = useState("");
  const [sourceChange, setSourceChange] = useState<AuthoritiesBuildSettings["sourceMode"]>();
  // An opened finding is reviewed below the citations, so opening it brings it into view.
  const revealFinding = useCallback((node: HTMLDivElement | null) => node?.scrollIntoView?.({ block: "nearest", behavior: "smooth" }), []);
  const [viewedStep, setViewedStep] = useState<{ key: string; value: Step }>();
  const [editingAuthority, setEditingAuthority] = useState<AuthorityIdentity>();
  const [sourcePreview, setSourcePreview] = useState<{ role: string; name: string;
    quote?: string; bytes?: Uint8Array; error?: string; recognizedText?: PdfRecognizedText; pageLabels?: Array<string | null> }>();
  const ocr = useSourceOcr(host, draft?.id), resetOcr = ocr.reset;
  // Asked once per host; a Word brief's final PDF then needs the brief saved as PDF only where it is false.
  const [wordToPdf, setWordToPdf] = useState<{ host: AuthoritiesHost; value: boolean }>();
  useEffect(() => {
    let active = true;
    void host.wordToPdf?.().then((value) => active && setWordToPdf({ host, value }))
      .catch(() => { /* Unknown: the build reports what it needs. */ });
    return () => { active = false; };
  }, [host]);
  const convertsWord = wordToPdf?.host === host ? wordToPdf.value : undefined;
  const [stubWarning, setStubWarning] = useState(false);
  const [buildLinks, setBuildLinks] = useState<{ draftId: string; revision: number;
    warnings: NonNullable<AuthoritiesBuildReceipt["linkWarnings"]> }>();
  const scanRequest = useRef<AbortController | null>(null);
  const previewRequest = useRef(0);
  const [sourceIssueState, setSourceIssueState] = useState<{
    draftId: string; sourceKey: string; issues: Record<string, AuthoritiesSourceIssue>;
  }>({ draftId: "", sourceKey: "", issues: {} });
  const [sourceAccessVersion, setSourceAccessVersion] = useState(0);
  const [accessPrompt, setAccessPrompt] = useState<{ draftId: string; denied: boolean }>();
  const [review, setReview] = useState<{ id: string; key: string;
    items: AuthoritiesDiscrepancy[]; error: string }>();
  const draftRef = useRef(draft);
  const buildRequest = useRef<AbortController | null>(null);
  const reviewRequest = useRef<AbortController | null>(null);
  const inspectionRequest = useRef(0), relinked = useRef(new Set<string>());
  const actionQueue = useRef(Promise.resolve());
  // Review edits shown at once and saved in order behind them, and the draft they make.
  const edits = useRef<Array<{ action: AuthoritiesAction; step?: ReviewStep }>>([]);
  // This draft's review edits, for Ctrl+Z, and those taken back, for Ctrl+Shift+Z and Ctrl+Y.
  const history = useRef<{ done: ReviewStep[]; undone: ReviewStep[] }>({ done: [], undone: [] });
  const replaying = useRef<ReviewStep | null>(null);
  const [preview, setPreview] = useState<AuthoritiesProduct>();
  const gathering = useRef(Promise.resolve()), gathered = useRef({ id: "", revision: -1 });
  // Gathering that an edit interrupted, to run again once editing rests.
  const sourcesRequest = useRef<AbortController | null>(null), sourcesStale = useRef(false);
  // Gathering reports which authority it is on; the step shows it only while someone waits for it,
  // so the citations being reviewed meanwhile are never re-rendered for it.
  const sourcesNote = useRef(""), awaitingSources = useRef(false);
  const [sourcesProgress, setSourcesProgress] = useState("");
  const noteSources = useCallback((note: string) => {
    sourcesNote.current = note;
    if (awaitingSources.current) setSourcesProgress(note);
  }, []);
  const modeDrafts = useRef<{ automatic?: string; manual?: string }>({});
  const refreshRequest = useRef(0);

  const adopt = useCallback((next?: AuthoritiesProduct, navigate = false, preserveTab = false) => {
    const current = draftRef.current;
    if (!navigate && (!next || current?.id !== next.id || next.revision < current.revision)) return false;
    if (navigate) {
      edits.current = []; history.current = { done: [], undone: [] };
      reviewRequest.current?.abort(); reviewRequest.current = null; setReview(undefined);
      setFindingId(""); setViewedStep(undefined);
      scanRequest.current?.abort(); resetOcr();
      previewRequest.current += 1; setSourcePreview(undefined);
      setSelectedId(orderedOccurrences(next)[0]?.id ?? "");
      setPendingAttachment(undefined); setError(""); setMessage("");
      setBuildLinks(undefined);
    }
    draftRef.current = next; setDraft(next);
    // Edits still saving stay on screen over the newer draft.
    setPreview(next && edits.current.length ? edits.current.reduce<AuthoritiesProduct>((view, { action }) =>
      previewEdit(view, action) ?? view, next) : undefined);
    if (next) {
      const mode = next.state.import.kind === "manual" ? "manual" : "automatic";
      modeDrafts.current[mode] = next.id;
      if (navigate && !preserveTab) setTab(mode);
      if (mode === "manual") setManualTitle(next.title);
      localStorage.setItem(lastDraftKey(projectId, host.mode), next.id);
      setDrafts((items) => [metadata(next), ...items.filter(({ id }) => id !== next.id)]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }
    return true;
  }, [projectId, host.mode, resetOcr]);
  function adoptSourceWrite(next: AuthoritiesProduct) {
    if (!adopt(next)) return false;
    // Replacing missing bytes with the same file leaves its binding and hash unchanged.
    inspectionRequest.current += 1;
    setSourceAccessVersion((value) => value + 1);
    return true;
  }
  const load = useCallback(async (id: string, preserveTab = false, remembered = false) => {
    const request = ++routeRequest.current;
    setLoading(!draftRef.current);
    try {
      const next = await host.drafts.get<AuthoritiesProduct["state"]>(id);
      if (next.kind !== "authorities") throw new Error("This is not an Authorities draft.");
      if (request !== routeRequest.current || draftRef.current?.id === next.id &&
          draftRef.current.revision > next.revision) return;
      adopt(next, true, preserveTab);
    } catch (caught) {
      if (request === routeRequest.current) {
        setError(errorText(caught));
        if (remembered && localStorage.getItem(lastDraftKey(projectId, host.mode)) === id)
          localStorage.removeItem(lastDraftKey(projectId, host.mode));
      }
    } finally { if (request === routeRequest.current) setLoading(false); }
  }, [host, adopt, projectId]);
  const refreshDraftEffect = useEffectEvent(async (expectedRevision: number) => {
    const current = draftRef.current;
    if (!current || current.revision >= expectedRevision) return;
    const request = ++refreshRequest.current;
    try {
      const next = await host.drafts.get<AuthoritiesProduct["state"]>(current.id);
      if (request === refreshRequest.current && draftRef.current?.id === current.id &&
          next.revision >= expectedRevision && next.revision > (draftRef.current?.revision ?? 0))
        adopt(next);
    } catch (caught) {
      if (request === refreshRequest.current) setError(errorText(caught));
    }
  });

  useEffect(() => {
    let active = true;
    const listed = host.drafts.listMetadata
      ? host.drafts.listMetadata("authorities", projectId)
      : host.drafts.list<AuthoritiesProduct["state"]>("authorities", projectId)
        .then((items) => items.map(metadata));
    void listed.then((items) => active && setDrafts(items))
      .catch((caught) => active && setError(errorText(caught)))
      .finally(() => active && setDraftsListedFor({ host, projectId }));
    return () => { active = false; };
  }, [projectId, host]);

  // A workflow launch asks for a fresh draft. Clear the remembered draft first
  // so the resume effect below cannot pull the previous one back in.
  useEffect(() => {
    if (!initialNewDraft) return;
    routeRequest.current += 1;
    const current = draftRef.current;
    if (current) delete modeDrafts.current[current.state.import.kind === "manual" ? "manual" : "automatic"];
    localStorage.removeItem(lastDraftKey(projectId, host.mode));
    adopt(undefined, true);
    setRestoredScope(projectId ?? "local");
    onInitialConsumed?.();
  }, [initialNewDraft, adopt, projectId, host.mode, onInitialConsumed]);

  // Entering the workspace without a draft in the route resumes the last one; leaving a
  // draft later is the reader's choice, and the scope is settled by then either way.
  useEffect(() => {
    const scope = projectId ?? "local";
    if (restoredScope === scope || draftRef.current) return;
    const id = requested ? "" : localStorage.getItem(lastDraftKey(projectId, host.mode));
    if (!id) { setRestoredScope(scope); return; }
    void load(id, false, true).finally(() => setRestoredScope(scope));
  }, [projectId, requested, restoredScope, load, host.mode]);

  useEffect(() => {
    if (requested === (draftRef.current?.id ?? "")) return;
    if (!requested) { adopt(undefined, true); setLoading(false); return; }
    void load(requested, tabRef.current === "drafts");
  }, [requested, projectId, adopt, load]);

  useEffect(() => {
    onDraftChange?.(draft, !!draft && !busy && !preview);
  }, [draft, busy, preview, onDraftChange]);
  useEffect(() => localStorage.setItem("beaver.authorities.preferences", JSON.stringify(preferences)),
    [preferences]);
  useEffect(() => () => {
    buildRequest.current?.abort(); scanRequest.current?.abort();
    reviewRequest.current?.abort();
  }, []);
  const draftId = draft?.id;
  const sourceKey = useMemo(() => sourceIssueKey(draft), [draft]);
  // Work that follows the citations (sources, scans, the quotation check) reads the draft once
  // editing rests, so an edit never waits for it and its results never interrupt one. A draft
  // that opens is read at once.
  const [idle, setIdle] = useState<AuthoritiesProduct>();
  useEffect(() => {
    if (!draft || preview || idle === draft) return;
    if (idle?.id !== draft.id) { setIdle(draft); return; }
    const timer = setTimeout(() => setIdle(draft), 1500);
    return () => clearTimeout(timer);
  }, [draft, preview, idle]);
  const settled = idle && idle.id === draftId ? idle : undefined;
  const citationKey = useMemo(() => settled ? canonicalJson([
    settled.state.authorityOrder.map(id => {
      const { citation, excluded, locators } = settled.state.authorities[id];
      return [id, citation, excluded, locators];
    // Text that cites no authority asks nothing of sources or scans.
    }), Object.values(settled.state.occurrences).flatMap(({ authorityId, reference, pinpoints }) =>
      authorityId || reference ? [[authorityId, reference, pinpoints]] : []), settled.state.settings.sourceMode,
  ]) : "", [settled]);
  const settledSourceKey = useMemo(() => sourceIssueKey(settled), [settled]);
  const scannedSources = useScannedSources(host, settled, `${settledSourceKey}:${citationKey}:${sourceAccessVersion}`);
  useEffect(() => {
    if (scannedSources.checking || draft?.state.settings.scannedPdfPolicy === "page-margin") return;
    const pending = scannedSources.files.filter(file => {
      const prior = ocr.tracked[file.role];
      return prior?.sourceSha256 !== file.sourceSha256 ||
        (!["paused", "cancelled", "failed"].includes(prior.state) && prior.demand !== file.demand);
    });
    if (pending.length) void ocr.begin(pending);
  }, [scannedSources.checking, scannedSources.files, draft?.state.settings.scannedPdfPolicy, ocr.tracked, ocr.begin]);
  const gatheredKey = useRef("");
  useEffect(() => {
    const current = draftRef.current, key = `${draftId}\0${citationKey}`;
    if (!settled || !current || current.id !== draftId || current.state.stage !== "citations" ||
        current.state.import.kind !== "document" || key === gatheredKey.current && !sourcesStale.current) return;
    gatheredKey.current = key; sourcesStale.current = false;
    gathering.current = gathering.current.then(() => gatherSources(2));
  }, [settled, citationKey, draft?.state.stage]); // eslint-disable-line react-hooks/exhaustive-deps
  const sameDraft = draft && sourceIssueState.draftId === draft.id;
  const sourceIssues = sameDraft && sourceIssueState.sourceKey === sourceKey
    ? sourceIssueState.issues : NO_SOURCE_ISSUES;
  useEffect(() => {
    let active = true;
    const current = draftRef.current;
    if (!current || current.id !== draftId)
      return () => { active = false; };
    const request = ++inspectionRequest.current;
    void host.inspectDraft(current).then((inspection) => {
      if (!active || request !== inspectionRequest.current) return;
      setSourceIssueState({ draftId: current.id,
        sourceKey: sourceIssueKey(current), issues: inspection.sourceIssues });
      // A source with a newer file is picked up on its own, never behind a button.
      const changed = Object.entries(inspection.sourceIssues).find(([role, issue]) =>
        issue.status === "changed" && !relinked.current.has(`${current.id}\0${role}`));
      if (changed && host.relinkSource) {
        relinked.current.add(`${current.id}\0${changed[0]}`);
        void relinkQueued(current.id, changed[0]).then((next) => next && relinkAdopted(next, changed[0]))
          .catch((caught) => setError(errorText(caught)));
      }
    }).catch((caught) => active && setError(errorText(caught)));
    return () => { active = false; };
  }, [draftId, sourceKey, sourceAccessVersion, refreshToken, host]);
  const reviewKey = useMemo(() => discrepancyKey(settled), [settled]);
  useEffect(() => {
    reviewRequest.current?.abort();
    // currentReview ignores a stored review for another draft or key, so none is cleared here.
    if (!draftId || !host.review || !reviewKey) return;
    const request = new AbortController(); reviewRequest.current = request;
    const id = draftId, key = reviewKey;
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
    if (draftId && refreshToken?.id === draftId) void refreshDraftEffect(refreshToken.revision);
  }, [draftId, refreshToken]);

  // The review and the authorities show unsaved edits; everything else reads the saved draft.
  const shown = preview ?? draft;
  const occurrences = useMemo(() => orderedOccurrences(shown), [shown]);
  const currentReview = review && draft && review.id === draft.id && review.key === reviewKey
    ? review : undefined;
  const discrepancies = useMemo(() => currentReview?.items ?? [], [currentReview]);
  // The list keeps the last check's findings while the next one runs, so its marks never blink.
  const findings = useMemo(() => review && review.id === draftId ? review.items : [], [review, draftId]);
  const selected = occurrences.find(({ id }) => id === selectedId) ?? occurrences[0];
  const selectedRef = useRef(selected?.id);
  selectedRef.current = selected?.id;
  useEffect(() => { if (!selected) onFocusChange?.(); }, [selected, onFocusChange]);
  const authorityPlan = useMemo(() => draft ? planAuthorities(draft) : [], [draft]);
  const authorities = useMemo(() => shown ? authorityPlan.map(({ id }) => shown.state.authorities[id]) : [],
    [shown, authorityPlan]);
  const authorityTabs = useMemo(() => new Map(authorityPlan.map(({ id, tab }) => [id, tab])), [authorityPlan]);
  const authorityGroups = useMemo(() => new Map(authorityPlan.map(({ id, group }) => [id, group])), [authorityPlan]);
  const missingPdfs = useMemo(() => draft ? missingSources(draft, sourceIssues, authorityPlan) : [],
    [draft, sourceIssues, authorityPlan]);
  const importedRole = draft?.state.import.kind === "document"
    ? draft.state.import.bindingRole : undefined;
  const importedIssue = importedRole ? sourceIssues[importedRole] : undefined;
  // A brief moved or deleted since it was chosen: found again where it is now.
  const briefMoved = importedIssue?.status === "missing" && importedIssue.reason === "deleted";
  const unreadable = draft && host.requestSourceAccess ? Object.entries(sourceIssues)
    .filter(([, issue]) => relinkable(issue)).flatMap(([role]) => {
      const input = draft.state.bindings[role];
      return input?.kind === "local-file" ? [{ role, name: input.lastSeen.name }] : [];
    }) : [];
  const accessOpen = !!draft && unreadable.length > 0 &&
    (accessPrompt?.draftId !== draft.id || accessPrompt.denied);
  async function requestSourceAccess() {
    if (!draft || !host.requestSourceAccess) return;
    const id = draft.id, granted = await host.requestSourceAccess(draft).catch(() => false);
    setAccessPrompt({ draftId: id, denied: !granted });
    if (granted) { inspectionRequest.current += 1; setSourceAccessVersion((value) => value + 1); }
  }
  const reviewError = !globalTab ? currentReview?.error || "" : "";
  // Work a step starts reports itself in that step, and so does the reason it stopped;
  // only unattached work needs the page-level line.
  const stepError = error && error === stepFailure ? error : "";
  const status = (stepError ? "" : error) || message || reviewError;
  const stepOperation = STEP_PROGRESS.has(operation) ? operation : "";
  const busyText = stepOperation ? "" : building ? "Building outputs"
    : pendingImport ? "Finding citations" : operation || "Updating authorities";
  const libraryAvailable = !!LibraryPicker;
  const attachLibraryAvailable = libraryAvailable && !!host.attachLibraryPdf;
  const sourceLabel = (draft?.projectId ?? projectId) ? "Project" : "Library";

  function newDraft(forget = true) {
    routeRequest.current += 1;
    if (forget) {
      const current = draftRef.current;
      if (current) delete modeDrafts.current[current.state.import.kind === "manual"
        ? "manual" : "automatic"];
      localStorage.removeItem(lastDraftKey(projectId, host.mode));
    }
    adopt(undefined, true);
  }
  function changeTab(next: WorkspaceTab) {
    if (next === "automatic" || next === "manual") {
      const current = draftRef.current;
      const activeMode = current?.state.import.kind === "manual" ? "manual" : "automatic";
      if (!current || next !== activeMode) {
        const target = modeDrafts.current[next];
        if (target) {
          adopt(undefined, true); void load(target);
        } else newDraft(false);
      }
    }
    setTab(next);
    setError(""); setMessage("");
  }
  async function run<T>(operationFn: () => Promise<T>, done: (value: T) => void,
    success = "", label = "Updating authorities") {
    // A ref, not state: a second click before the next render must not start a second run.
    if (runningRef.current) return;
    runningRef.current = true;
    // The last message stays until this one reports, so the status line does not blink.
    setBusy(true); setOperation(label); setError("");
    // A message `done` sets itself wins over the default one.
    try { const value = await operationFn(); setMessage(success); done(value); }
    catch (caught) {
      if ((caught as { name?: string })?.name === "AbortError")
        setMessage(label === "Finding source PDFs" ? "Search cancelled" : "Build cancelled");
      else {
        const text = errorText(caught);
        setError(text); if (STEP_PROGRESS.has(label)) setStepFailure(text);
      }
    }
    finally { runningRef.current = false; setBusy(false); setOperation(""); }
  }
  /** Runs a change after every queued one, so each starts from the revision the last saved. */
  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const result = actionQueue.current.then(task);
    actionQueue.current = result.then(() => undefined, () => undefined);
    return result;
  }
  /** A save made to the draft as it is when the save's turn comes. One that landed meanwhile
   *  without this workspace (sources gathered on the server) is read, and the save made again on
   *  it, as often as one lands while the save is made (sources arrive one after another). */
  async function onLatest(id: string, save: (current: AuthoritiesProduct) => Promise<AuthoritiesProduct>) {
    let current = draftRef.current;
    if (current?.id !== id) throw new Error("This draft is no longer open.");
    for (let attempt = 1; ; attempt += 1) {
      try { return await save(current); }
      catch (caught) {
        if ((caught as { status?: number })?.status !== 409 || attempt === 6) throw caught;
        current = await host.drafts.get<AuthoritiesProduct["state"]>(id);
        adopt(current);
      }
    }
  }
  const queuedSave = (id: string, save: (current: AuthoritiesProduct) => Promise<AuthoritiesProduct>) =>
    serialized(() => onLatest(id, save));
  /** The citation that carries on an edited one: itself, or the citation that now covers it. */
  const carryOn = (action: AuthoritiesAction, before: AuthoritiesProduct, next: AuthoritiesProduct) => {
    const prior = "occurrenceId" in action ? before.state.occurrences[action.occurrenceId] : null;
    const unit = prior && next.state.units.find(({ id }) => id === prior.unitId);
    const items = unit?.occurrenceIds.flatMap((id) => next.state.occurrences[id] ? [next.state.occurrences[id]] : []) ?? [];
    const replacement = prior && (next.state.occurrences[prior.id] ??
      items.find(({ start, end }) => start <= prior.start && end >= prior.end));
    if (replacement) setSelectedId(replacement.id);
  };
  /** The draft as the review shows it: the saved draft with the edits still saving. */
  const editedView = () => edits.current.reduce<AuthoritiesProduct>((view, { action }) =>
    previewEdit(view, action) ?? view, draftRef.current!);
  const act: ActionHandler = (action, done) => {
    const targetId = draftRef.current?.id;
    if (!targetId) return;
    // A review edit shows at once and saves behind the view; anything else holds the workspace.
    const shown = editedView(), view = previewEdit(shown, action);
    // A review edit is a step Ctrl+Z takes back; one replayed by Ctrl+Z or Ctrl+Y belongs to its step.
    const step = view ? replaying.current ?? reviewStep(shown, view, action) ?? undefined : undefined;
    const edit = view ? { action, step } : undefined;
    const blocking = !edit && action.type !== "rename-authority";
    if (blocking) setPendingActions((count) => count + 1);
    if (edit && view) {
      if (step && !replaying.current) {
        step.from = selectedRef.current;
        history.current = { done: [...history.current.done, step], undone: [] };
      }
      edits.current.push(edit); keepPending(targetId); sourcesRequest.current?.abort();
      setPreview(view); carryOn(action, shown, view); void done?.(view);
    }
    actionQueue.current = actionQueue.current.then(async () => {
      try {
        // An edit already shows: its save starts once that frame is painted, never ahead of it.
        if (edit) await afterPaint();
        const current = draftRef.current;
        if (!current || current.id !== targetId) return;
        const sent = edit?.action ?? action;
        const next = await onLatest(targetId, (latest) => host.act(latest.id, latest.revision, sent));
        if (edit) {
          // Later edits and the selection follow citations the save named differently.
          const names = savedIds(previewEdit(current, sent) ?? current, next);
          const renamed = (item: AuthoritiesAction) => "occurrenceId" in item && names.has(item.occurrenceId)
            ? { ...item, occurrenceId: names.get(item.occurrenceId)! } : item;
          // Renamed in place: each edit is found again by itself when its own save lands.
          edits.current = edits.current.filter((item) => item !== edit);
          for (const item of edits.current) item.action = renamed(item.action);
          for (const step of [...history.current.done, ...history.current.undone]) Object.assign(step, {
            undo: step.undo.map(renamed), redo: step.redo.map(renamed), target: names.get(step.target) ?? step.target });
          setSelectedId((id) => names.get(id) ?? id);
          keepPending(targetId);
        }
        if (!adopt(next)) return;
        // A refusal stays on screen only until the next edit lands, never as if that edit failed.
        setError("");
        if (!edit) { carryOn(action, current, next); await done?.(next); }
      } catch (caught) {
        if (edit) {
          // The edit is taken back: the view returns to the saved draft and the edits after it, and
          // its step leaves the history.
          edits.current = edits.current.filter((item) => item !== edit);
          const { done, undone } = history.current, kept = (item: ReviewStep) => item !== edit.step;
          history.current = { done: done.filter(kept), undone: undone.filter(kept) };
          keepPending(targetId); adopt(draftRef.current);
        }
        setError(errorText(caught));
      }
      finally { if (blocking) setPendingActions((count) => Math.max(0, count - 1)); }
    });
  };
  /** The edits shown but not yet saved, kept by the browser the moment each is made: a reload or a
   *  closed tab before a save lands loses none of them. */
  const keepPending = (id: string) => {
    try {
      const actions = draftRef.current?.id === id ? edits.current.map(({ action }) => action) : [];
      if (actions.length) localStorage.setItem(pendingKey(id), JSON.stringify(actions));
      else localStorage.removeItem(pendingKey(id));
    } catch { /* Storage refused: the edits still save as they are made. */ }
  };
  // A draft that opens makes again the edits its last page showed but had not saved yet.
  useEffect(() => {
    const id = draftRef.current?.id;
    if (!id) return;
    let pending: AuthoritiesAction[] = [];
    try { pending = JSON.parse(localStorage.getItem(pendingKey(id)) ?? "[]"); } catch { /* none kept */ }
    for (const action of pending) if (!holds(editedView(), action)) act(action);
  }, [draft?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Ctrl+Z takes the last review edit back, and Ctrl+Shift+Z or Ctrl+Y makes it again. Each shows
   *  and saves as any edit does, and selects the citation it was about; where that citation is gone,
   *  the one selected when the edit was made, or else the next one. */
  const travel = (back: boolean) => {
    const { done, undone } = history.current, step = (back ? done : undone).at(-1);
    if (!step || !draftRef.current) return false;
    history.current = back ? { done: done.slice(0, -1), undone: [...undone, step] }
      : { done: [...done, step], undone: undone.slice(0, -1) };
    const order = orderedOccurrences(editedView()).map(({ id }) => id);
    replaying.current = step;
    try { for (const action of back ? step.undo : step.redo) act(action); } finally { replaying.current = null; }
    const now = new Set(orderedOccurrences(editedView()).map(({ id }) => id)), at = order.indexOf(step.target);
    setSelectedId([step.target, step.from, ...order.slice(at + 1), ...order.slice(0, Math.max(0, at)).reverse()]
      .find((id) => id && now.has(id)) ?? "");
    return true;
  };
  const resolveDiscrepancy: DiscrepancyHandler = (finding, action, done) => {
    const id = draftRef.current?.id;
    if (!id || !host.resolveDiscrepancy) return;
    void run(() => queuedSave(id, (current) => host.resolveDiscrepancy!(current.id,
      { id: finding.id, action, revision: current.revision })), (next) => {
      adopt(next); done();
    }, action === "ignore" ? "Quotation difference dismissed"
      : host.mode === "standalone" ? "Corrected Word copy saved with this draft"
        : "Source corrected and draft refreshed", "Correcting source");
  };

  /** The brief is read the moment it is chosen, with the choices remembered from the last import, and
   *  opened behind the import's choices: its sources are found, and its scans read, while they are made. */
  function startImport(source: NonNullable<Parameters<AuthoritiesHost["create"]>[0]["source"]>, name: string) {
    setLibraryTarget(undefined); setError(""); setMessage("");
    const request = ++importRequest.current, title = name.replace(/\.[^.]+$/u, "") || "Authorities";
    setPendingImport({ title, finishing: false, error: "" });
    staged.current = host.create({ source, title, projectId, settings: preferences }).then((next) => {
      if (request !== importRequest.current) { void host.drafts.remove(next.id).catch(() => undefined); return undefined; }
      adopt(next, true); return next;
    }, (caught) => {
      if (request === importRequest.current) setPendingImport((current) => current && { ...current, error: errorText(caught) });
      return undefined;
    });
  }
  const queueDocument = (document: Document) => startImport({ kind: "document", document }, document.filename);
  const queueFile = (selected?: AuthoritiesFile) => selected && startImport({ kind: "file", selected }, selected.file.name);
  /** Leaving the import discards the draft read for it. */
  function cancelImport() {
    importRequest.current += 1; setPendingImport(undefined);
    const current = draftRef.current;
    if (!current) return;
    newDraft();
    setDrafts((items) => items.filter((item) => item.id !== current.id));
    void host.drafts.remove(current.id).catch(() => undefined);
  }
  /** The draft read from the brief takes the choices that differ from those it was read with: the
   *  review is there at once, and anything a choice changes is done behind it. */
  function finishImport(actionsFor: (state: AuthoritiesProduct["state"]) => AuthoritiesAction[], chosen: Remembered) {
    const request = importRequest.current;
    setPendingImport((current) => current && { ...current, finishing: true });
    void staged.current.then((created) => {
      if (!created || request !== importRequest.current) return;
      setPreferences(chosen); setPendingImport(undefined);
      const pending = (state: AuthoritiesProduct["state"]) => actionsFor(state).flatMap((action): AuthoritiesAction[] => {
        if (action.type !== "set-settings") return [action];
        const locked = authoritiesProfile(state.settings.profileId).locked?.settings ?? {};
        const settings = Object.fromEntries(Object.entries(action.settings).filter(([key, value]) => !(key in locked) &&
          JSON.stringify(state.settings[key as keyof typeof state.settings]) !== JSON.stringify(value)));
        return Object.keys(settings).length ? [{ ...action, settings }] : [];
      });
      if (!draftRef.current || !pending(draftRef.current.state).length) return;
      void run(() => serialized(async () => {
        let current = draftRef.current!;
        for (let index = 0; ; index += 1) {
          const action = pending(current.state)[0];
          if (!action || index > 3) return current;
          current = await onLatest(current.id, (latest) => host.act(latest.id, latest.revision, pending(latest.state)[0] ?? action));
          adopt(current);
        }
      }), adopt);
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
    void run(() => serialized(async () => {
      const manualPreferences = bookPreferences(preferences), open = draftRef.current;
      let current = open?.state.import.kind === "manual" ? open : await host.create({
        source: { kind: "manual" }, title: manualTitle.trim() || "Book of Authorities",
        // A table-only court's "none" is not a choice for a book; any other marking is the reader's own.
        projectId, settings: { ...manualPreferences, sourceMode: "manual-originals", outputMode: "book",
          passageMarking: manualPreferences.passageMarking === "none" ? "margin" : manualPreferences.passageMarking },
      });
      if (current !== open) { adopt(current, true); }
      for (let index = 0; index < pdfs.length; index += 1) {
        const selected = pdfs[index], before = new Set(current.state.authorityOrder);
        const filename = pdfChoiceName(selected);
        const label = filename.replace(/\.pdf$/iu, "").replace(/[_-]+/gu, " ").trim()
          || `Authority ${index + 1}`;
        setMessage(`Adding ${index + 1} of ${pdfs.length}`);
        current = await onLatest(current.id, (latest) => host.act(latest.id, latest.revision,
          { type: "add-authority", kind: "other", citation: label, name: label }));
        adopt(current);
        const authorityId = current.state.authorityOrder.find((id) => !before.has(id));
        if (!authorityId) throw new Error("The PDF could not be added.");
        current = await onLatest(current.id, (latest) => isLibraryDocument(selected)
          ? host.attachLibraryPdf!(latest.id, latest.revision, selected,
            { kind: "authority", authorityId, language: "en" })
          : host.attach(latest.id, authorityId, latest.revision, selected));
        adoptSourceWrite(current);
      }
      return current;
    }), (next) => { adopt(next, true); }, `${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"} added`);
  }
  function attach(authorityId: string, selected?: PdfChoice,
    language?: AuthoritySourceLanguage) {
    const current = draftRef.current, authority = current?.state.authorities[authorityId];
    if (!current || !authority || !selected) return;
    if (!language && requiresBilingualSources(current.state, authority)) {
      setPendingAttachment({ authorityId, selected }); return;
    }
    void run(() => queuedSave(current.id, (latest) => isLibraryDocument(selected)
      ? host.attachLibraryPdf!(latest.id, latest.revision, selected,
        { kind: "authority", authorityId, language: language ?? "en" })
      : host.attach(latest.id, authorityId, latest.revision, selected, language)), adoptSourceWrite,
    `${pdfChoiceName(selected)} attached`);
  }
  function attachBookFiles(slot: AuthoritiesBookSlot,
    selected: PdfChoice[], supplementId?: string) {
    // Saved to the draft as it is once the changes asked for before it (an output choice) are saved.
    const id = draftRef.current?.id;
    if (!id || !selected.length || (!host.attachBookPdf && !host.attachLibraryPdf)) return;
    const files = slot === "supplemental" && !supplementId ? selected : selected.slice(0, 1);
    void run(() => serialized(async () => {
      let current: AuthoritiesProduct | undefined;
      for (let index = 0; index < files.length; index += 1) {
        const selected = files[index];
        setMessage(files.length > 1 ? `Adding ${index + 1} of ${files.length}` : "Adding file");
        current = await onLatest(id, (latest) => isLibraryDocument(selected)
          ? host.attachLibraryPdf!(latest.id, latest.revision, selected, { kind: "book", slot, supplementId })
          : host.attachBookPdf!(latest.id, latest.revision, slot, selected, supplementId));
        adoptSourceWrite(current);
      }
      return current;
    }), adopt, files.length > 1 ? `${files.length} files added` : `${pdfChoiceName(files[0])} added`);
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
  function relinkQueued(id: string, role: string) {
    return serialized(async () => {
      const current = draftRef.current;
      return current?.id === id ? host.relinkSource!(current.id, role, current.revision) : undefined;
    });
  }
  function relinkAdopted(next: AuthoritiesProduct, role: string) {
    if (!adoptSourceWrite(next)) return;
    setSourceIssueState((current) => {
      const { [role]: _resolved, ...issues } = current.issues;
      return { ...current, issues };
    });
  }
  function relinkSource(role: string) {
    const id = draftRef.current?.id;
    if (!id || !host.relinkSource) return;
    void run(() => relinkQueued(id, role), (next) => { if (next) relinkAdopted(next, role); },
      "Source relinked");
  }
  // Auto-fetch from folder: the reader chooses the folder Chrome saves into once, and it is kept for
  // the next visit. While the tab is open, each PDF saved there that is an authority still without
  // a PDF is attached to it, looked for every two seconds and whenever the tab is come back to.
  const [watchedFolder, setWatchedFolder] = useState<string>();
  // A folder kept from an earlier visit that Chrome asks about again: asked on the next click.
  const [folderAccess, setFolderAccess] = useState<{ handle: WatchedFolder; open?: boolean }>();
  const folder = useRef<{ handle: WatchedFolder; timer: number } | null>(null);
  const folderTried = useRef(new Set<string>()), folderScanning = useRef(false);
  const busyRef = useRef(busy), scanRef = useRef<() => Promise<void>>(async () => {});
  busyRef.current = busy;
  useEffect(() => { folderTried.current.clear(); }, [draft?.id]);
  useEffect(() => {
    let active = true;
    const look = () => void scanRef.current();
    window.addEventListener("focus", look);
    void host.watchedFolder?.get().then(async (kept) => {
      const handle = kept as WatchedFolder | null;
      if (!active || !handle || folder.current) return;
      if (await handle.queryPermission?.({ mode: "read" }) === "granted") watch(handle);
      else setFolderAccess({ handle });
    }).catch(() => { /* No folder is kept. */ });
    return () => { active = false; window.removeEventListener("focus", look); };
  }, [host]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (folder.current) clearInterval(folder.current.timer); }, []);
  function watch(handle: WatchedFolder, chosen = false) {
    folderTried.current.clear(); setFolderAccess(undefined);
    folder.current = { handle, timer: window.setInterval(() => void scanRef.current(), 2_000) };
    setWatchedFolder(handle.name);
    if (chosen) setMessage(`Watching ${handle.name}. Each PDF saved there is added to the authority it belongs to.`);
    void scanRef.current();
  }
  function stopWatching(text = "") {
    if (folder.current) clearInterval(folder.current.timer);
    folder.current = null; setWatchedFolder(undefined);
    if (text) setMessage(text);
  }
  async function allowFolder() {
    const handle = folderAccess?.handle;
    if (handle && await handle.requestPermission?.({ mode: "read" }).catch(() => "denied") === "granted") watch(handle, true);
    else setFolderAccess(handle && { handle });
  }
  /** Each PDF not looked at before, newest first, is asked which authority still without a PDF it
   *  is; one that is none stays where it is. Only a match holds the workspace while it attaches. */
  async function attachFromFolder(files: File[], quiet: boolean) {
    const current = draftRef.current, matches: Array<{ authorityId: string; file: File }> = [];
    if (!current || !host.pdfAuthority) return;
    const waiting = () => Object.values(current.state.authorities).some((authority) => authority.kind === "case" &&
      !authority.excluded && authority.source.kind !== "attached" && requiresPdf(current.state, authority) &&
      !matches.some(({ authorityId }) => authorityId === authority.id));
    for (const file of files.filter((file) => /\.pdf$/iu.test(file.name) && file.size <= 100 * 1024 * 1024 &&
      !folderTried.current.has(folderFileId(file))).sort((left, right) => right.lastModified - left.lastModified)) {
      if (draftRef.current?.id !== current.id || !waiting()) break;
      folderTried.current.add(folderFileId(file));
      const authorityId = await pdfOpening(file).then((opening) => host.pdfAuthority!(current, opening)).catch(() => null);
      if (authorityId && !matches.some((match) => match.authorityId === authorityId)) matches.push({ authorityId, file });
    }
    if (!matches.length) {
      if (!quiet) setMessage("None of the PDFs there belongs to an authority that still needs one.");
      return;
    }
    await run(() => serialized(async () => {
      let added = 0;
      const failures: string[] = [];
      for (const { authorityId, file } of matches) {
        if (draftRef.current?.id !== current.id) break;
        try {
          if (adopt(await onLatest(current.id, (latest) =>
            host.attach(latest.id, authorityId, latest.revision, { file, autoFetched: true })))) added += 1;
        } catch (caught) { failures.push(`${file.name}: ${errorText(caught)}`); }
      }
      return { added, failures };
    }), ({ added, failures }) => {
      setMessage(""); autoFetchToast(added);
      if (failures.length) setError(failures.join("\n"));
    },
    "", "Adding PDFs from the folder");
  }
  scanRef.current = async function scanFolder() {
    const watched = folder.current?.handle;
    if (!watched || folderScanning.current || busyRef.current) return;
    folderScanning.current = true;
    try {
      // Chrome's access can end with the visit; the folder is then asked for on the next click.
      const permission = await watched.queryPermission?.({ mode: "read" });
      if (permission && permission !== "granted") { stopWatching(); setFolderAccess({ handle: watched }); return; }
      const files: File[] = [];
      for await (const entry of watched.values())
        if (entry.kind === "file" && /\.pdf$/iu.test(entry.name)) files.push(await entry.getFile());
      await attachFromFolder(files, true);
    } catch (caught) { stopWatching(`Stopped watching the folder. ${errorText(caught)}`); }
    finally { folderScanning.current = false; }
  };
  async function watchFolder() {
    if (folder.current) {
      void host.watchedFolder?.set(null);
      return stopWatching("Stopped watching the folder.");
    }
    if (folderAccess) return setFolderAccess({ ...folderAccess, open: true });
    const picker = (window as FolderPickerWindow).showDirectoryPicker;
    if (!picker) {
      // Without folder access (Firefox, Safari) the folder is read once.
      const input = Object.assign(document.createElement("input"),
        { type: "file", multiple: true, webkitdirectory: true });
      input.onchange = () => void attachFromFolder(Array.from(input.files ?? [])
        .filter((file) => file.webkitRelativePath.split("/").length <= 2), false);
      input.click();
      return;
    }
    let handle: WatchedFolder;
    try { handle = await picker({ id: "authorities-downloads", mode: "read", startIn: "downloads" }); }
    catch (caught) {
      if ((caught as { name?: string })?.name !== "AbortError") setError(errorText(caught));
      return;
    }
    void host.watchedFolder?.set(handle);
    watch(handle, true);
  }
  function rename(title: string) {
    if (draft) void run(() => queuedSave(draft.id, (current) =>
      host.drafts.update<AuthoritiesProduct["state"]>(current.id, { revision: current.revision, title })), adopt);
  }
  function duplicate() {
    if (!draft) return;
    void run(() => host.drafts.duplicate<AuthoritiesProduct["state"]>(draft.id,
      { title: `${draft.title} copy` }), (next) => { adopt(next, true); });
  }
  function removeDraft() {
    if (!draft) return;
    const id = draft.id;
    void run(() => host.drafts.remove(id), () => {
      setDrafts((current) => current.filter((item) => item.id !== id)); newDraft();
    });
  }
  async function build(given?: AuthoritiesProduct, force = false) {
    if (!given && !draftRef.current) return;
    const request = new AbortController(); buildRequest.current = request; setBuilding(true);
    void run(async () => {
      // Output choices still saving are part of what the reader asked to build.
      await actionQueue.current;
      const current = given ?? draftRef.current;
      if (!current) return null;
      const inspection = await host.inspectDraft(current);
      request.signal.throwIfAborted();
      if (draftRef.current?.id !== current.id || draftRef.current.revision !== current.revision)
        throw new Error("The draft changed. Build again to use the current version.");
      setSourceIssueState({ draftId: current.id, sourceKey: sourceIssueKey(current), issues: inspection.sourceIssues });
      if (!force && missingSources(current, inspection.sourceIssues).length) {
        setStubWarning(true); return null;
      }
      return host.build(current, setMessage, request.signal);
    },
      (result) => {
        if (!result) return;
        const { product, notice, receipt } = result;
        inspectionRequest.current += 1;
        setSourceIssueState((current) => {
          const key = sourceIssueKey(product);
          return { draftId: product.id, sourceKey: key,
            issues: current.draftId === product.id && current.sourceKey === key
              ? current.issues : {} };
        });
        adopt(product); setMessage(notice || "Outputs ready");
        setBuildLinks({ draftId: product.id, revision: product.revision,
          warnings: receipt.linkWarnings ?? [] });
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
        setSourcePreview(value => ({ ...value, role, name, quote, bytes: new Uint8Array(buffer) }));
    }).catch((caught) => {
      if (request === previewRequest.current) setSourcePreview({ role, name, quote, error: errorText(caught) });
    });
    void host.readSourceText?.(current, role).then(recognizedText => {
      if (request === previewRequest.current && draftRef.current?.id === current.id)
        setSourcePreview(value => value ? { ...value, recognizedText } : value);
    }).catch(() => { /* The PDF remains readable if optional text preparation fails. */ });
    void host.readSourcePageLabels?.(current, role).then(pageLabels => {
      if (request === previewRequest.current && draftRef.current?.id === current.id)
        setSourcePreview(value => value ? { ...value, pageLabels } : value);
    }).catch(() => { /* Unknown labels retain physical navigation. */ });
  }
  // The quotation belongs at the pinpoint the author cited, so open the PDF on that passage.
  function openFindingSource(finding: AuthoritiesDiscrepancy) {
    const source = draftRef.current?.state.authorities[finding.authorityId]?.source;
    const role = source?.kind === "attached" ? source.sources[0]?.bindingRole : undefined;
    if (role) openSource(role, (finding.found ?? finding.cited).text);
  }

  /** The PDFs a draft cites are gathered as soon as its citations are known, not on request. */
  async function gatherSources(attempts: number): Promise<void> {
    const current = draftRef.current;
    if (!attempts || !current || current.state.stage !== "citations") return;
    // An edit stops this request rather than wait for it; gathering resumes once editing rests.
    const request = new AbortController(); sourcesRequest.current = request;
    try {
      await serialized(async () => {
        const latest = draftRef.current;
        if (request.signal.aborted || latest?.id !== current.id || latest.state.stage !== "citations") return;
        const next = await host.prepareSources(latest, request.signal, undefined, noteSources)
          .finally(() => { sourcesNote.current = ""; });
        if (adopt(next)) gathered.current = { id: next.id, revision: next.revision };
      });
    } catch {
      if (request.signal.aborted) { sourcesStale.current = true; return; }
      await gatherSources(attempts - 1);
    } finally { if (sourcesRequest.current === request) sourcesRequest.current = null; }
  }
  function findSources() {
    if (!draftRef.current) return;
    const request = new AbortController(); scanRequest.current?.abort(); scanRequest.current = request;
    let unavailable = "";
    awaitingSources.current = true; setSourcesProgress(sourcesNote.current);
    void run(async () => {
      await gathering.current;
      const id = draftRef.current?.id;
      if (!id) throw new Error("Open a draft first.");
      // Each write waits its turn behind every other save, and is made again on a newer draft
      // should one land meanwhile (sources still arriving, a gathering retried).
      const prepared = await queuedSave(id, (current) =>
        gathered.current.id === current.id && gathered.current.revision === current.revision ? Promise.resolve(current)
          // A legal-source service that is down or limiting requests leaves the sources to add by
          // hand: the step still opens, and says why nothing was found.
          : host.prepareSources(current, request.signal, undefined, noteSources).catch((caught) => {
            if ((caught as { status?: number })?.status !== 503) throw caught;
            unavailable = errorText(caught); return current;
          }));
      request.signal.throwIfAborted();
      if (prepared !== draftRef.current) adopt(prepared);
      return queuedSave(id, (current) => host.act(current.id, current.revision, { type: "set-stage", stage: "sources" }));
    }, (next) => { adopt(next); if (unavailable) setMessage(unavailable); }, "", "Finding source PDFs").finally(() => {
      awaitingSources.current = false; setSourcesProgress("");
      if (scanRequest.current === request) scanRequest.current = null;
    });
  }
  function retryPublisherSource(authorityId: string) {
    const id = draftRef.current?.id;
    if (!id) return;
    const request = new AbortController();
    void run(() => queuedSave(id, (current) => host.prepareSources(current, request.signal, authorityId)), adopt,
      "", "Retrying source PDF");
  }
  const reached = draft?.state.stage ?? (draft && Object.keys(draft.outputs).length ? "build"
    : draft?.state.import.kind === "manual" ? "sources" : "citations");
  const stepKey = `${draft?.id}:${reached}`;
  // An earlier step viewed belongs to the step the draft had reached then: once the draft moves,
  // back (an edit) or on (Next), it lapses, and never comes back when the draft returns there.
  const [viewedFor, setViewedFor] = useState(stepKey);
  if (viewedFor !== stepKey) { setViewedFor(stepKey); if (viewedStep) setViewedStep(undefined); }
  const stage = viewedStep?.key === stepKey ? viewedStep.value : reached;
  // Each source's marks are prepared while Sources or Highlights is on screen, so Highlights opens
  // them at once; never during the review or a build, which would wait behind it.
  useHighlightsAhead(host, draft && (stage === "sources" || stage === "highlights") ? draft : undefined, ocr.tracked);
  const statuteCopies = useStatuteCopies(host, draft, shown, ocr.tracked, stage === "sources" || stage === "highlights");
  const steps = STEPS.filter(({ value }) => value !== "citations" || draft?.state.import.kind !== "manual")
    .map(step => ({ ...step, disabled: busy || STEPS.findIndex(({ value }) => value === step.value) >
      STEPS.findIndex(({ value }) => value === reached) }));
  // A step's note ("… attached") belongs to that step, so moving on clears it.
  const viewStep = (value: Step) => { setMessage(""); setViewedStep({ key: stepKey, value }); };
  const advance = (next: Step) => {
    if (STEPS.findIndex(({ value }) => value === next) <= STEPS.findIndex(({ value }) => value === reached)) viewStep(next);
    else { setMessage(""); act({ type: "set-stage", stage: next }); }
  };
  // The book's own PDFs: the cover and index at Build, any other PDF under a tab of its own at Sources.
  const bookFiles: BookFiles = {
    onFiles: (slot, files, supplementId) => attachBookFiles(slot, files.map((file) => ({ file })), supplementId),
    onPick: host.pickFiles ? (slot, multiple, supplementId) => void pickFiles(
      multiple, "pdf", (files) => attachBookFiles(slot, files, supplementId)) : undefined,
    onLibrary: attachLibraryAvailable ? (slot, supplementId) => openLibrary({ kind: "book", slot, supplementId }) : undefined,
  };
  const reproduced = authorityPlan.filter(({ tab }) => tab !== "Not reproduced").length;
  const others = draft && draft.state.outputMode !== "table" ? { ...bookFiles,
    parts: draft.state.bookParts.supplements.map((part, index) => ({ part,
      tab: tabLabel(reproduced + index + 1, draft.state.settings.tabStyle, draft.state.settings) })) } : undefined;
  const buildPanel = draft && stage === "build" && <BuildPanel host={host} draft={shown!} busy={busy} building={building}
    progress={building ? message : ""} convertsWord={convertsWord}
    jurisdictionOrder={jurisdictionOrder}
    linkWarnings={buildLinks?.draftId === draft.id && buildLinks.revision === draft.revision
      ? buildLinks.warnings : undefined}
    onAction={act} sourceIssues={sourceIssues}
    onRelink={relinkSource} onOpenSource={host.readSource ? openSource : undefined}
    files={bookFiles} sourceLabel={sourceLabel} onBuild={() => build()} onCancel={() => buildRequest.current?.abort()}
    onDownload={download} />;
  const highlightPanel = draft && stage === "highlights" && <AuthoritiesHighlights key={draft.id} product={draft}
    tabs={authorityTabs} busy={busy} host={host} ocr={ocr} onAction={act} onSaved={adopt} />;
  // An open finding stays in place while its quotations are rechecked (items undefined).
  const quotationReview = draft && findingId && (!currentReview || discrepancies.length > 0) &&
    <QuotationReview items={currentReview?.items} currentId={findingId}
      busy={busy || !currentReview} error={error || currentReview?.error} onSelect={setFindingId}
      onOpenSource={host.readSource ? openFindingSource : undefined}
      onResolve={host.resolveDiscrepancy ? resolveDiscrepancy : undefined}
      onDone={() => setFindingId("")} />;
  // The sources' settings chosen at import, closed under one bar naming them, opening to the same
  // cards as the import's Sources step. A new source handling drops only the PDFs found for it and
  // finds them again; uploaded PDFs stay.
  const sourced = !!draft && draft.state.import.kind === "document", recognition = host.recognitionAvailable !== false;
  const sourceSettings = draft && <SourceChoices settings={draft.state.settings} profileId={draft.state.settings.profileId}
    sources={sourced} recognition={recognition} disabled={busy} onChange={({ sourceMode, ...patch }) => sourceMode
      ? setSourceChange(sourceMode) : act({ type: "set-settings", settings: patch })} />;
  // A new source handling throws away the PDFs the app found, so it asks first.
  const changeSources = (sourceMode: AuthoritiesBuildSettings["sourceMode"]) => {
    setSourceChange(undefined);
    act({ type: "set-settings", settings: { sourceMode } }, async (next) => {
      setOperation("Finding source PDFs");
      try { adopt(await onLatest(next.id, (latest) => host.prepareSources(latest, undefined, undefined, noteSources))); }
      finally { setOperation(""); }
    });
  };
  const authorityPanelProps = { authorities, tabs: authorityTabs, groups: authorityGroups, busy, sourceIssues, statuteCopies,
    onAction: act, onEditIdentity: setEditingAuthority,
    onRetrySource: retryPublisherSource,
    onOpenSource: host.readSource ? openSource : undefined, onAdd: () => setAddOpen(true),
    onPick: host.pickFiles ? (id: string) => void pickFiles(false, "pdf",
      (files) => attach(id, files[0])) : undefined,
    onLibrary: attachLibraryAvailable
      ? (authorityId: string) => openLibrary({ kind: "authority", authorityId }) : undefined,
    sourceLabel, onAttach: (id: string, file?: File) => attach(id, file && { file }),
    onRelink: relinkSource, onWatchFolder: () => void watchFolder(), watchedFolder };

  const settingsAction = host.outputFolder && <Button type="button" variant="outline" aria-label="Settings"
    className="h-9 w-9 shrink-0 border-gray-400 px-0 sm:w-auto sm:px-4"
    disabled={busy || locked} onClick={() => setSettingsOpen(true)}>
    <Settings2 /><span className="hidden sm:inline">Settings</span></Button>;

  // Always present, so the header never shifts; with no draft open, this already is a new one.
  const newAction = <Button type="button" variant="outline" className="h-9 border-gray-400"
    disabled={!draft || busy || locked} title={draft ? undefined : "No draft is open"}
    onClick={() => newDraft()}><Plus /> New</Button>;

  const reviewable = !!draft && tab !== "drafts" && draft.state.import.kind === "document";
  const reviewing = reviewable && stage === "citations";
  // Once drawn, the review stays drawn, unseen, on the other steps, so going back to Citations shows
  // it as it was left, in its first frame.
  const [reviewed, setReviewed] = useState("");
  if (reviewing && reviewed !== draft.id) setReviewed(draft.id);
  // An edit still saving takes the draft back to Citations when it lands, so Next waits for it
  // and finds the sources again, as it does once the edit has landed.
  const stepNext = reviewing ? () => reached === "citations" || edits.current.length ? findSources() : viewStep("sources")
    // Next goes straight on: scans are read in the background as the draft's scanned-PDF choice
    // says, each row showing how far, and nothing waits on them.
    : stage === "sources" ? () => advance("highlights")
    : stage === "highlights" ? () => advance("build") : undefined;
  const stepping = !!draft && tab !== "drafts";
  // The sections share the header row and the status shares the step row, so the step below starts high.
  const sections = <TabList value={tab} onValueChange={changeTab} options={TABS}
    ariaLabel="Authorities sections" variant="dock" panelId="authorities-panel"
    className="min-h-0 border-0 bg-transparent px-0 py-0 sm:px-0 max-[22rem]:[&_.tab-list]:justify-between max-[22rem]:[&_.tab-list]:gap-0 max-[22rem]:[&_[role=tab]]:px-1" />;
  const statusLine = <Status busy={busy} inline={!!draft && tab !== "drafts"}
    busyText={busyText} status={status} error={!!(error || (!message && reviewError))} />;
  return <div className={cn("authorities-workspace @container/workspace relative bg-app-background [scrollbar-gutter:stable]",
    host.mode === "standalone" ? "h-dvh overflow-y-auto" : "min-h-full lg:h-full lg:min-h-0 lg:overflow-y-auto")}>
    {draft ? <WorkspaceHeader className={host.mode === "standalone" ? FRAME : undefined} current={draft}
        busy={busy || locked} itemLabel="authorities draft"
        onBack={() => newDraft(false)} onRename={rename} onDuplicate={duplicate}
        onDelete={removeDraft} headerActions={<>{sections}{newAction}{headerActions}{settingsAction}</>} />
        : <WorkspaceHeader className={host.mode === "standalone" ? FRAME : undefined} title="Authorities"
          headerActions={<>{sections}{newAction}{headerActions}{settingsAction}</>} />}
    <div inert={locked} aria-busy={locked || undefined}>
          <main className={cn(FRAME, "min-h-80", stepping ? "pt-1" : "pt-4", reviewing ? "pb-0" : "pb-4")}>
        {!(draft && tab !== "drafts") && statusLine}
        <div id="authorities-panel" role="tabpanel"
          aria-labelledby={`authorities-panel-tab-${TABS.findIndex(({ value }) => value === tab)}`}>
        {loading || (!requested &&
          !!localStorage.getItem(lastDraftKey(projectId, host.mode)) &&
          restoredScope !== (projectId ?? "local")) ? <Loading /> : tab === "drafts"
          ? <DraftsPanel drafts={drafts} loading={draftsLoading} busy={busy} onOpen={(id) => void run(
              () => host.drafts.get<AuthoritiesProduct["state"]>(id), (next) => {
                adopt(next, true);
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
                    ariaLabel="Book steps" variant="subtab" panelId="authorities-step"
                    // The steps keep a fixed share of the row, and the actions the height of Next, so no
                    // status or action moves them or the step below.
                    className="gap-3 [&_[role=tab]]:text-sm [&_.tab-list]:w-[min(40rem,60%)] [&_.tab-list]:flex-none [&>[data-tabs-actions]]:min-h-9 [&>[data-tabs-actions]]:min-w-0 [&>[data-tabs-actions]]:flex-1 [&>[data-tabs-actions]]:justify-end"
                    actions={<>{statusLine}
                      {/* The brief itself, unreadable on any step: allowed again, or found where it was moved. */}
                      {importedRole && host.relinkSource && (relinkable(importedIssue) || briefMoved) && <Button type="button"
                        variant="outline" className="h-9 border-gray-400" disabled={busy}
                        onClick={() => relinkSource(importedRole)}><FilePlus2 />
                        {briefMoved ? "Reconnect" : "Allow file access"}</Button>}
                      <StepProgress label={stepOperation === "Finding source PDFs" && sourcesProgress || stepOperation}
                        error={stepError} className="min-w-0" />
                      {/* Every step's Next sits here; the last step keeps its room. */}
                      <Button className={cn("h-9", !stepNext && "invisible")} aria-hidden={!stepNext || undefined}
                        tabIndex={stepNext ? undefined : -1} disabled={busy || !stepNext}
                        onClick={stepNext}>Next<ChevronRight /></Button></>} />
                  {/* Every step starts the same distance below the steps, so switching moves nothing. */}
                  {/* The header and the steps keep one width; Sources, Highlights and Build take a narrower
                      column under them than the review, which needs the document's width. */}
                  <div id="authorities-step" role="tabpanel" className={cn("flow-root [&>*:first-child]:mt-2", !reviewing && "mx-auto max-w-[56rem]")}
                    aria-labelledby={`authorities-step-tab-${steps.findIndex(({ value }) => value === stage)}`}>
                  {sourceChange && <Modal open fit onClose={() => setSourceChange(undefined)} breadcrumbs={["Change source handling"]} size="md"
                    secondaryAction={{ label: "Cancel", onClick: () => setSourceChange(undefined) }}
                    primaryAction={{ label: "Change", disabled: busy, onClick: () => changeSources(sourceChange) }}>
                    <p className="pb-4 text-sm text-gray-700">Changing source handling removes the PDFs the app found and finds them
                      again for the new choice. PDFs you uploaded stay.</p></Modal>}
                  {stage === "sources" && <><Sources key={draft.id} draft={draft} occurrences={occurrences}
                    ocr={ocr} others={others} settings={sourceSettings}
                    {...authorityPanelProps}
                    {...(draft.state.import.kind === "manual" ? {
                      onPickMany: host.pickFiles ? () => void pickFiles(true, "pdf", appendManual) : undefined,
                      onLibraryAdd: attachLibraryAvailable ? () => openLibrary({ kind: "manual" }) : undefined,
                      onFiles: (files: File[]) => appendManual(files.map((file) => ({ file }))),
                    } : {})} />
                    {host.recognitionAvailable === false && scannedSources.files.length > 0 &&
                      <p className="mt-3 text-sm text-gray-700">Text recognition isn’t available here, so scanned pages stay as images.</p>}</>}
                  {highlightPanel}
                  {buildPanel}
                  {/* The review stays drawn, held still, while Next finds the sources; Sources replaces it. It comes
                      last, so on another step that step's own panel is the first below the steps. */}
                  {reviewable && reviewed === draft.id && <div inert={!reviewing} aria-hidden={!reviewing || undefined}
                    // Unseen, it keeps its own size, place and scroll under a box of no height, so nothing in
                    // it is laid out or drawn again either way.
                    className={reviewing ? undefined : "h-0 overflow-clip"}><section aria-label="Citations"
                    className="@container overflow-hidden rounded-xl border border-gray-300 bg-white shadow-sm">
                    <CitationReview product={shown!} host={host} sourceVersion={sourceAccessVersion} occurrences={occurrences}
                      selected={selected} authorities={authorities} discrepancies={findings} hidden={!reviewing}
                      busy={busy} onSelect={setSelectedId} onAction={act} onHistory={travel}
                      onFocusChange={onFocusChange} onReview={setFindingId} />
                  </section></div>}
                  {reviewing && quotationReview && <div ref={revealFinding}>{quotationReview}</div>}
                  </div>
                </>}
        </div>
      </main>
      {LibraryPicker && <LibraryPicker open={!!libraryTarget}
        key={`${draft?.id}:${draft?.projectId ?? projectId}:${libraryTarget?.kind}`}
        title={libraryTitle(libraryTarget, sourceLabel)}
        projectId={draft?.projectId ?? projectId}
        formats={libraryTarget?.kind === "import" ? ["pdf", "docx"] : ["pdf"]}
        onSelect={chooseLibrary} onClose={() => setLibraryTarget(undefined)} />}
      {host.outputFolder && <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} size="xl"
        breadcrumbs={["Settings"]} fit primaryAction={{ label: "Done", onClick: () => setSettingsOpen(false) }}>
        <div className="pb-4"><OutputFolderSetting port={host.outputFolder} busy={busy} /></div>
      </Modal>}
      {pendingImport && <ImportWizard key={importRequest.current} title={pendingImport.title} host={host}
        draft={draft} remembered={preferences} jurisdictionOrder={jurisdictionOrder}
        recognitionAvailable={host.recognitionAvailable !== false} finishing={pendingImport.finishing}
        error={pendingImport.error} onCancel={cancelImport} onFinish={finishImport} />}
      {addOpen && <AuthorityDetailsModal open busy={busy} onClose={() => setAddOpen(false)}
        onSave={(kind, citation, name) => {
          setAddOpen(false);
          act({ type: "add-authority", kind, citation, name }, async (next) => {
            if (next.state.stage !== "citations") {
              setOperation("Finding source PDF");
              // Already in the save queue's turn: made again on a newer draft, never queued behind itself.
              try { adopt(await onLatest(next.id, (latest) => host.prepareSources(latest))); }
              finally { setOperation(""); }
            }
          });
        }} />}
      {editingAuthority && <AuthorityDetailsModal open busy={busy} authority={editingAuthority}
        onClose={() => setEditingAuthority(undefined)} onSave={(kind, citation, name) => {
          act({ type: "edit-authority", authorityId: editingAuthority.id, kind, citation, name });
          setEditingAuthority(undefined);
        }} />}
      <Modal open={accessOpen} size="md" breadcrumbs={["File access"]} fit
        onClose={() => draft && setAccessPrompt({ draftId: draft.id, denied: false })}
        secondaryAction={{ label: "Not now", onClick: () => draft &&
          setAccessPrompt({ draftId: draft.id, denied: false }) }}
        primaryAction={{ label: "Allow access", onClick: () => void requestSourceAccess() }}>
        <p className="text-sm leading-6 text-gray-700">Chrome asks again before this draft can read
          its files. Choose <strong>Allow on every visit</strong> so it won’t ask next time.</p>
        <ul className="my-3 max-h-36 divide-y divide-gray-200 overflow-y-auto rounded-lg border border-gray-300 bg-gray-50 text-sm">
          {unreadable.map(file => <li key={file.role} className="truncate px-3 py-2" title={file.name}>{file.name}</li>)}
        </ul>
        {accessPrompt?.denied && <p role="alert" className="pb-3 text-sm text-red-800">Chrome did not allow
          access. Allow it again, or choose the file with Allow file access.</p>}
      </Modal>
      <Modal open={!!folderAccess?.open} size="md" breadcrumbs={["Folder access"]} fit
        onClose={() => folderAccess && setFolderAccess({ handle: folderAccess.handle })}
        // Declined, the kept folder is let go: the next click chooses one afresh.
        secondaryAction={{ label: "Not now", onClick: () => {
          setFolderAccess(undefined); void host.watchedFolder?.set(null); } }}
        primaryAction={{ label: "Allow access", onClick: () => void allowFolder() }}>
        <p className="pb-3 text-sm leading-6 text-gray-700">Chrome asks again before Authorities can watch{" "}
          <strong>{folderAccess?.handle.name}</strong>. Choose <strong>Allow on every visit</strong> so it
          won’t ask next time.</p>
      </Modal>
      <Modal open={stubWarning} onClose={() => setStubWarning(false)} size="lg"
        breadcrumbs={["Missing PDFs"]} fit
        secondaryAction={{ label: "Review sources", disabled: busy, onClick: () => {
          setStubWarning(false); viewStep("sources");
        } }}
        primaryAction={{ label: "Build", disabled: busy, onClick: () => {
          setStubWarning(false);
          // The setting is queued before the build, which waits for queued saves and builds the result.
          if (!draftRef.current?.state.settings.allowIncomplete)
            act({ type: "set-settings", settings: { allowIncomplete: true } });
          void build(undefined, true);
        } }}>
        <p className="text-sm leading-6 text-gray-700">{missingPdfs.length === 1 ? "One authority has" : `${missingPdfs.length} authorities have`} no
          PDF. {draft && missingPdfs.some(({ id }) => !authorityReproducedInBook({ ...draft.state,
            settings: { ...draft.state.settings, allowIncomplete: true } }, draft.state.authorities[id]))
            ? `The book is built without ${missingPdfs.length === 1 ? "it" : "them"}, and every tab keeps its number.`
            : `${missingPdfs.length === 1 ? "It keeps" : "Each keeps"} its tab, with a page naming it where its PDF goes.`}</p>
        <ul className="mb-5 mt-3 max-h-[min(19rem,42dvh)] divide-y divide-gray-200 overflow-y-auto rounded-lg border border-gray-300">
          {missingPdfs.map(item => <li key={item.id} className="grid min-h-10 grid-cols-[4.5rem_minmax(0,1fr)_auto] items-center gap-3 px-3 py-1.5">
            <span className="truncate text-xs tabular-nums text-gray-500">{authorityTabs.get(item.id)}</span>
            <span className="truncate text-sm font-medium text-gray-950" title={draft ? authorityCitationText(draft.state, item) : authorityLabel(item)}>{authorityName(item)}</span>
            <span className="max-w-48 truncate text-xs text-gray-600">{draft && authorityCitationLine(draft.state, item)}</span>
          </li>)}
        </ul>
      </Modal>
      <Modal open={!!sourcePreview} size="2xl" breadcrumbs={[sourcePreview?.name ?? "Source PDF"]}
        className="h-[min(900px,calc(100dvh-2rem))]" bodyClassName="pb-5"
        onClose={() => { previewRequest.current += 1; setSourcePreview(undefined); }}>
        <div className="flex min-h-60 flex-1">
          <PdfCanvas bytes={sourcePreview?.bytes} loading={!!sourcePreview && !sourcePreview.bytes && !sourcePreview.error}
            recognizedText={sourcePreview?.recognizedText} pageLabels={sourcePreview?.pageLabels}
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
  return <div className="beaver-loading-indicator grid h-80 place-items-center rounded-xl border border-gray-300 bg-white text-sm text-gray-600" role="status">
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
      onChange={(profileId) => onPreferences(courtChosen(preferences, profileId))} />
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
      <h2 className="font-semibold text-gray-950">Saved drafts</h2></div>
    <div className="h-[28rem] overflow-y-auto">
      {loading ? <div className="beaver-loading-indicator grid h-full place-items-center px-4 py-12 text-sm text-gray-500"
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

function BuildPanel({ host, draft, busy, building, progress, jurisdictionOrder, onAction, sourceIssues,
  convertsWord, linkWarnings, onRelink, files, sourceLabel, onOpenSource, onBuild, onCancel, onDownload }: {
  host: AuthoritiesHost; draft: AuthoritiesProduct; busy: boolean; building: boolean;
  /** What the build is doing now. */
  progress: string;
  convertsWord?: boolean;
  linkWarnings?: AuthoritiesBuildReceipt["linkWarnings"];
  jurisdictionOrder: string[];
  onAction: ActionHandler; onBuild: () => void; onCancel: () => void;
  sourceIssues: Record<string, AuthoritiesSourceIssue>; onRelink: (role: string) => void;
  files: BookFiles;
  sourceLabel?: string;
  onOpenSource?: (role: string) => void;
  onDownload: (documentId: string, versionId: string, filename: string) => void;
}) {
  const [frontOpen, setFrontOpen] = useState(false);
  const [options, setOptions] = useState<"book" | "word" | "final">();
  const [courtNote, setCourtNote] = useState<{ id: string; text: string }>();
  const { state } = draft, settings = state.settings;
  const profile = authoritiesProfile(settings.profileId);
  const manual = state.import.kind === "manual";
  const wordDocument = state.import.kind === "document" && state.import.fileType === "docx";
  const book = state.outputMode !== "table", table = state.outputMode !== "book";
  const generatedFederalCover = book && coverForm(settings.profileId) === "federal" && !state.bookParts.cover;
  const coverDetailsReady = !generatedFederalCover || completeFederalCover(state.cover);
  const filingRoleReady = !generatedFederalCover || !!settings.bookRole;
  const indexShows = settings.indexShows ?? (profile.requirements?.federalFormatting ? "tabs-and-pages" : "tabs");
  // Without a converter here, a Word brief reaches the final PDF as a PDF the user saved from Word.
  const briefSlot = wordDocument && convertsWord === false;
  const brief = state.bookParts.brief ?? undefined;
  const waiting = briefSlot && !brief && !!settings.finalPdf;
  const onOptions = ({ insertIntoDocument, ...changed }: AuthoritiesOutputOptionsValue) => {
    if (insertIntoDocument !== undefined) onAction({ type: "set-document-output", enabled: insertIntoDocument });
    if (Object.keys(changed).length) onAction({ type: "set-settings", settings: changed });
  };
  const outputMode = (makeBook: boolean, makeTable: boolean) => onAction({ type: "set-output-mode",
    outputMode: makeBook && makeTable ? "both" : makeTable ? "table" : "book" });
  // What Build still needs is said beside it. A missing PDF is no such thing: the book builds without it.
  const note = !coverDetailsReady ? "Add the cover details to build." : !filingRoleReady ? "Choose who is filing to build." : "";
  const lockedMode = profile.locked?.outputMode ? `${profile.label} takes a Table of Authorities, not a book.` : undefined;
  const tabbed = (settings.citationSuffix ?? "none") !== "none";
  const wordParts = [...state.insertIntoDocument ? [settings.tableDelivery === "native-marks"
      ? "each citation marked for Word’s Table of Authorities"
      : settings.tableDelivery === "linked-append" ? "a linked Table of Authorities on a new last page"
        : "each citation marked and Word’s Table of Authorities on a new last page"] : [],
    ...tabbed ? ["its tab after each citation"] : []];
  const toggle = (key: NonNullable<typeof options>) => setOptions((open) => open === key ? undefined : key);
  const tableOptions = !manual && (wordDocument ? <>
    <AuthoritiesOutputOptions disabled={busy} value={{ ...settings, insertIntoDocument: state.insertIntoDocument }}
      lockedDelivery={profile.locked?.settings?.tableDelivery}
      firstTab={tabLabel(1, settings.tabStyle, settings)} onChange={onOptions} />
    <TableOptions draft={draft} busy={busy} onMade={(made) => outputMode(book || !made, made)} onAction={onAction} />
  </> : <TableOptions draft={draft} busy={busy} onMade={(made) => outputMode(book || !made, made)} onAction={onAction} pdfBrief />);
  const cards: OutputCard[] = [
    { key: "book", title: "Book of Authorities", roles: Object.keys(draft.outputs).filter((role) => /^book(?:-\d+)?$/u.test(role)),
      sentence: book ? "Creates a PDF that contains the cover, the index and each authority behind its tab." : lockedMode ?? "Not made.",
      // Options only where there is a choice: whether to make it, or what to do without a PDF.
      ...(!manual && !lockedMode && table) || profile.options?.missingSourcePolicy ? { onOptions: () => toggle("book"), open: options === "book",
        options: <OutputOptions made={book} madeLabel="Make the Book of Authorities" lockedReason={lockedMode}
          disabled={busy || manual || !table} onMade={(made) => outputMode(made, table)}
          madeDetail="Creates a PDF that contains the cover, the index and each authority behind its tab.">
          {profile.options?.missingSourcePolicy && <OptionCards legend="Authorities without a PDF" value={settings.missingSourcePolicy}
            disabled={busy} options={[{ value: "placeholder", label: "Keep their tabs", detail: "A page naming the authority takes its place." },
              { value: "omit", label: "Leave out of the book", detail: "The other tabs keep their numbers." }]}
            onChange={(missingSourcePolicy) => onAction({ type: "set-settings", settings: { missingSourcePolicy } })} />}
        </OutputOptions> } : {} },
    ...manual ? [] : [wordDocument ? { key: "word", title: "Word copy", roles: ["annotated-document", "table"],
      sentence: [wordParts.length ? `Creates a copy of your brief with ${wordParts.join(", and ")}.` : "",
        table ? "Creates a Table of Authorities as a separate Word document." : ""].join(" ").trim() || "Not made.",
      onOptions: () => toggle("word"), open: options === "word", options: tableOptions }
      : { key: "word", title: "Table of Authorities", roles: ["table", "annotated-document"],
        sentence: [table ? "Creates a Table of Authorities as a Word document." : "",
          state.insertIntoDocument ? "Creates a PDF that contains your brief followed by the table and the authorities." : ""].join(" ").trim() || "Not made.",
        onOptions: () => toggle("word"), open: options === "word", options: tableOptions },
    { key: "final", title: "Final PDF", roles: ["final-pdf", "link-report"],
      sentence: settings.finalPdf ? `Creates a PDF that contains your brief followed by the book.${waiting ? " Note: Requires you to upload your brief as a PDF." : ""}` : "Not made.",
      onOptions: () => toggle("final"), open: options === "final",
      options: <OutputOptions made={!!settings.finalPdf} madeLabel="Make the final PDF" disabled={busy}
        madeDetail="Creates a PDF that contains your brief followed by the book." onMade={(finalPdf) => onOptions({ finalPdf })}>
        <FinalPdfOptions value={settings} onChange={onOptions} disabled={busy}
          brief={briefSlot ? <BriefPdf draft={draft} busy={busy} part={brief}
            onAction={onAction} onPick={files.onPick} onFiles={files.onFiles} /> : undefined} />
      </OutputOptions> }],
  ];
  // The book on the left, the outputs and Build on the right, one above the other where narrow.
  return <section className="@container/build mt-3 rounded-xl border border-gray-300 bg-white p-4 shadow-sm">
    <div className="grid items-start gap-6 @min-[46rem]/build:grid-cols-[minmax(0,1fr)_24rem]">
    <div className="grid min-w-0 gap-5">
      <div className="grid max-w-md gap-1">
        <AuthoritiesCourtField value={settings.profileId} disabled={busy}
          preferredKeys={jurisdictionOrder} bookOnly={manual}
          onChange={(profileId) => profileId !== settings.profileId && onAction({ type: "set-profile", profileId },
            (next) => setCourtNote({ id: next.id, text: courtChange(state, next.state) }))} />
        {/* What the court changed: its line is always there, so saying it moves nothing. */}
        <p role="status" className="min-h-4 text-xs leading-4 text-gray-600">{courtNote?.id === draft.id ? courtNote.text : ""}</p>
      </div>
      {book && <BookContents draft={draft} busy={busy} onAction={onAction}
        sourceIssues={sourceIssues} onRelink={onRelink} files={files} sourceLabel={sourceLabel}
        onOpen={onOpenSource} settings={{
          cover: { label: coverDetailsReady && filingRoleReady ? "Edit" : "Add details",
            detail: generatedFederalCover && !(coverDetailsReady && filingRoleReady) ? "Details required"
              : `Generated${state.cover.title ? ` · ${state.cover.title}` : ""}`, onClick: () => setFrontOpen(true) },
          index: { label: "Edit", detail: `Generated · ${indexShows === "tabs-and-pages" ? "tabs and pages" : "tabs"}`,
            onClick: () => setFrontOpen(true) } }} />}
    </div>
    <OutputCards draft={draft} cards={cards} busy={busy} building={building} progress={progress} note={note}
      linkWarnings={linkWarnings} onBuild={note ? () => setFrontOpen(true) : onBuild} onCancel={onCancel} onDownload={onDownload} />
    </div>
    {frontOpen && <BookFrontModal host={host} draft={draft} busy={busy} onClose={() => setFrontOpen(false)}
      onActions={(actions) => actions.forEach((action) => onAction(action))} />}
  </section>;
}

/** The Table of Authorities as a Word document of its own: whether it is made and where it says an
 *  authority is cited; for a PDF brief, also how the table is made and the brief with it in one PDF. */
function TableOptions({ draft, busy, onMade, onAction, pdfBrief = false }: { draft: AuthoritiesProduct; busy: boolean;
  onMade: (made: boolean) => void; onAction: ActionHandler; pdfBrief?: boolean }) {
  const { state } = draft, profile = authoritiesProfile(state.settings.profileId);
  const table = state.outputMode !== "book";
  return <>
    <OptionCard type="checkbox" checked={table} disabled={busy || !!profile.locked?.outputMode}
      onChange={(event) => onMade(event.target.checked)} label="A Table of Authorities in its own Word document"
      detail={profile.locked?.outputMode ? `${profile.label} takes a Table of Authorities.` : "Each authority, grouped and ordered as the book is, with where the brief cites it."} />
    {table && <div className="grid gap-3 sm:grid-cols-2">
      {pdfBrief && <SelectField label="Table" value={state.settings.tableDelivery}
        disabled={busy || !!profile.locked?.settings?.tableDelivery}
        onChange={(tableDelivery) => onAction({ type: "set-settings", settings: { tableDelivery } })}
        options={[{ value: "native-append", label: "Word’s table" }, { value: "linked-append", label: "Linked table" },
          { value: "native-marks", label: "Marked citations only" }]} />}
      <SelectField label="Cited at" value={state.settings.tableLocation} disabled={busy}
        onChange={(tableLocation) => onAction({ type: "set-settings", settings: { tableLocation } })}
        options={[{ value: "pages", label: "Pages" }, { value: "pinpoints", label: "Pinpoints" },
          { value: "combined", label: "Pages and pinpoints" }]} />
    </div>}
    {pdfBrief && <OptionCard type="checkbox" checked={state.insertIntoDocument} disabled={busy}
      onChange={(event) => onAction({ type: "set-document-output", enabled: event.target.checked })}
      label="Filing PDF" detail="Your brief, then the Table of Authorities, then the authorities, in one PDF." />}
  </>;
}

/** The brief saved as PDF from Word: what a final PDF is built from where Word is not converted here. */
function BriefPdf({ draft, busy, part, onAction, onPick, onFiles }: {
  draft: AuthoritiesProduct; busy: boolean; part?: { filename: string };
  onAction: (action: AuthoritiesAction) => void;
  onPick?: (slot: AuthoritiesBookSlot, multiple: boolean) => void;
  onFiles?: (slot: AuthoritiesBookSlot, files: File[]) => void;
}) {
  const filename = draft.state.import.kind === "document" ? draft.state.import.filename : "the brief";
  const label = part ? "Replace" : "Upload", control = cn(rowControl, "w-[5.625rem] px-2.5");
  return <FileCard disabled={busy} label={part?.filename ?? "Not added yet"} detail={part
    ? "If you change the brief, save it as PDF again and replace this one."
    : briefPdfAdvice(filename, { ...draft.state.settings, insertIntoDocument: draft.state.insertIntoDocument })}
    action={<span className="flex items-center gap-1">
      {onPick ? <Button type="button" variant="outline" className={control} disabled={busy}
        aria-label={`${label} the brief PDF`} onClick={() => onPick("brief", false)}><Upload />{label}</Button>
        : onFiles && <FileInputButton multiple={false} disabled={busy} label={label}
          ariaLabel={`${label} the brief PDF`} accept=".pdf,application/pdf" variant="outline"
          className={control} icon={<Upload />} onFiles={(files) => onFiles("brief", files)} />}
      {/* The menu keeps its room when there is nothing to remove, so the button never moves. */}
      {part ? <MoreActionsMenu label="Brief PDF options" items={[{ label: "Remove", disabled: busy,
        onSelect: () => onAction({ type: "clear-book-part", slot: "brief" }) }]}
        triggerClassName="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600" />
        : <span className="w-8 shrink-0" />}
    </span>} />;
}

/** What a generated cover or index is made from, and the button that opens its settings. */
type BookPartSettings = { label: string; detail: string; onClick: () => void };
/** The book's cover and index, each the page the book makes until a PDF replaces it, in rows as dense
 *  as the Sources list's: what it is, how it is made, then its settings, View, Replace and its options.
 *  Each row keeps the room of the buttons it may show, so a PDF arriving moves nothing. */
function BookContents({ draft, busy, onAction, sourceIssues, onRelink, files, sourceLabel = "Library", onOpen, settings }: {
  draft: AuthoritiesProduct; busy: boolean; onAction: (action: AuthoritiesAction) => void;
  sourceIssues: Record<string, AuthoritiesSourceIssue>; onRelink: (role: string) => void;
  files: BookFiles; sourceLabel?: string; onOpen?: (role: string) => void;
  settings: Partial<Record<"cover" | "index", BookPartSettings>>;
}) {
  const moreTrigger = "flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600";
  const room = "w-10 shrink-0 @min-[44rem]/sources:w-[5.625rem]";
  // Its actions always name themselves: the cover and index rows have the room.
  const frontControl = cn(rowControl, "w-auto px-2.5");
  return <div className="@container/sources min-w-0">
    <h3 className="mb-2 text-sm font-semibold text-gray-950">Cover and index</h3>
    <div className="grid grid-cols-[auto_fit-content(8rem)_minmax(0,max-content)_auto_minmax(0,1fr)] gap-x-2 divide-y divide-gray-200 rounded-lg border border-gray-300">
      {(["cover", "index"] as const).map((slot) => {
        const part = draft.state.bookParts[slot], issue = part ? sourceIssues[part.bindingRole] : undefined;
        const title = slot === "cover" ? "Cover" : "Index", own = settings[slot];
        const mark = !part ? { Icon: FileType2, tone: "text-indigo-700", label: "Generated page" }
          : issue ? { Icon: relinkable(issue) ? LockKeyhole : FileX2, tone: "text-red-700", label: "This PDF is unavailable" }
          : { Icon: FileCheck2, tone: "text-green-700", label: "Your PDF" };
        return <div key={slot} className="col-span-full grid min-h-10 grid-cols-subgrid items-center py-1 pl-3 pr-2">
          <span className="flex h-4 w-4 items-center justify-center"><mark.Icon role="img" aria-label={mark.label}
            className={cn("h-4 w-4", mark.tone)}><title>{mark.label}</title></mark.Icon></span>
          <span className="pr-4 text-sm font-medium text-gray-950">{title}</span>
          <span className="min-w-0 truncate text-xs text-gray-500" title={part?.filename}>
            {part?.filename ?? own?.detail ?? "Generated"}</span>
          <div className="flex items-center gap-1 pl-4">
            {own && !part ? <Button type="button" variant="outline" className={frontControl} disabled={busy}
              aria-label={`${own.label}: ${title.toLowerCase()}`} title={own.label} onClick={own.onClick}>
              <SlidersHorizontal /><span>{own.label}</span></Button>
              : part && onOpen ? <Button type="button" variant="outline" className={frontControl}
              aria-label={`View the ${slot}`} title="View" disabled={busy}
              onClick={() => onOpen(part.bindingRole)}><Eye /><span>View</span></Button>
              : <span className={room} />}
            {/* A slot without a PDF holds the generated page, so a chosen PDF always replaces one. */}
            {part && relinkable(issue) ? <Button type="button" variant="outline" className={cn(frontControl, "text-red-800")}
              disabled={busy} onClick={() => onRelink(part.bindingRole)}><FilePlus2 /><span className="truncate">Allow file access</span></Button>
              : files.onPick ? <Button type="button" variant="outline" className={frontControl}
              aria-label={`Replace the ${part ? "" : "generated "}${slot} with a PDF`} title="Replace"
              disabled={busy} onClick={() => files.onPick!(slot, false)}><Upload /><span>Replace</span></Button>
              : <FileInputButton multiple={false} disabled={busy} label="Replace"
                ariaLabel={`Replace the ${part ? "" : "generated "}${slot} with a PDF`} accept=".pdf,application/pdf"
                onFiles={(chosen) => files.onFiles(slot, chosen)} variant="outline" compact className={frontControl}
                icon={<Upload />} labelClassName="inline" />}
            {files.onLibrary && <Button type="button" variant="outline" className={frontControl}
              aria-label={`Choose ${title} from ${sourceLabel}`} title={sourceLabel} disabled={busy}
              onClick={() => files.onLibrary!(slot)}><FolderSearch /><span>{sourceLabel}</span></Button>}
            {part ? <MoreActionsMenu label={`${title} options`} triggerClassName={moreTrigger} items={[{ label: "Use generated",
              disabled: busy, onSelect: () => onAction({ type: "clear-book-part", slot }) }]} />
              : <span className="w-8 shrink-0" />}
          </div>
          <span />
        </div>;
      })}
    </div>
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
    breadcrumbs={[authority ? "Edit source" : "Add source"]}
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


function Status({ busy, busyText, status, error, inline = false }: { busy: boolean; busyText: string;
  status: string; error: boolean; inline?: boolean }) {
  const visible = (busy && !!busyText) || !!status;
  // The line keeps its height when empty so the step below never shifts as work starts and ends;
  // beside the steps it fills the row's free width, so a longer message never moves its box.
  return <p className={cn("flex items-center px-1 text-sm", inline ? "min-w-0 flex-1 justify-end truncate" : "mb-1 min-h-6",
    visible && "font-medium", busy && !status && "beaver-loading-indicator",
    error ? "text-red-800" : "text-gray-600")}
    role="status" aria-live="polite" aria-atomic="true" aria-busy={busy || undefined}
    title={inline ? status || undefined : undefined}>
    {visible && <span className="mr-2 grid size-4 shrink-0 place-items-center" aria-hidden="true">
      {busy && <Loader2 className="size-4 motion-safe:animate-spin" />}
    </span>}
    {busy ? status || busyText : status}
  </p>;
}
const STEP_PROGRESS = new Set(["Finding source PDFs", "Checking source PDFs"]);
const STEPS = [{ value: "citations", label: "Citations" }, { value: "sources", label: "Sources" },
  { value: "highlights", label: "Highlights" }, { value: "build", label: "Build book" }] as const;
type Step = typeof STEPS[number]["value"];

const withProfile = (value: StartPreferences, profileId: AuthoritiesProfileId): StartPreferences =>
  ({ ...value, profileId, passageMarking: authoritiesProfile(profileId).requirements?.markedPassages &&
    value.passageMarking === "none" ? "margin" : value.passageMarking });
/** A court chosen at import brings its own passage marking (King's Bench: the yellow paragraph). */
const courtChosen = (value: StartPreferences, profileId: AuthoritiesProfileId): StartPreferences =>
  withProfile({ ...value, passageMarking: authoritiesProfile(profileId).defaults.settings.passageMarking }, profileId);

const NO_SOURCE_ISSUES: Record<string, AuthoritiesSourceIssue> = {};
const pendingKey = (id: string) => `beaver.authorities.pending.${id}`;
const afterPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
function missingSources(draft: AuthoritiesProduct,
  sourceIssues: Record<string, AuthoritiesSourceIssue> = {}, plan = planAuthorities(draft)) {
  const roles = authoritiesInputPlan(draft.state,
    authoritiesProfile(draft.state.settings.profileId).requirements).byteRoles;
  return plan.map(({ id }) => draft.state.authorities[id])
    .filter((item) => !item.excluded &&
      (missingSource(draft.state, item, draft.state.stage !== "citations") ||
        item.source.kind === "attached" && item.source.sources.some(source =>
          roles.has(source.bindingRole) && sourceIssues[source.bindingRole]?.status === "missing")));
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
function planAuthorities({ state }: AuthoritiesProduct) {
  return deriveAuthorityProcedure(authorityProcedureInput(state,
    { purpose: state.outputMode === "table" ? "table" : "book" }));
}
const errorText = (error: unknown) => errorMessage(error, "Authorities could not be updated.");
const lastDraftKey = (projectId: string | undefined, mode: AuthoritiesHost["mode"]) =>
  `beaver.authorities.${mode === "standalone" ? "standalone." : ""}last.${projectId ?? "library"}`;
function loadPreferences(): StartPreferences {
  try {
    const value = JSON.parse(localStorage.getItem("beaver.authorities.preferences") ?? "null") as
      Partial<StartPreferences> | null;
    return value && AUTHORITY_PROFILE_BY_ID.has(value.profileId ?? "") &&
      SOURCE_OPTIONS.some(({ value: id }) => id === value.sourceMode) &&
      PASSAGE_OPTIONS.some(({ value: id }) => id === value.passageMarking)
      ? withProfile(value as StartPreferences, value.profileId!) : DEFAULTS;
  } catch { return DEFAULTS; }
}

type WatchedFolder = FileSystemDirectoryHandle & {
  values(): AsyncIterable<FileSystemFileHandle | FileSystemDirectoryHandle>;
  queryPermission?(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" }): Promise<PermissionState>;
};
const folderFileId = (file: File) => `${file.name}\0${file.size}\0${file.lastModified}`;
type FolderPickerWindow = Window & { showDirectoryPicker?: (options: { id: string; mode: "read";
  startIn: "downloads" }) => Promise<WatchedFolder> };
