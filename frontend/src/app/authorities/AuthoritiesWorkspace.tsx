import { BookOpen, ChevronRight, Download, FilePlus2, FolderSearch,
  History, Link2, Loader2, Plus, Scale, Settings2 } from "lucide-react";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState,
  type ComponentType, type ReactNode } from "react";
import { Modal } from "@/app/components/modals/Modal";
import { ChoiceModalButton, JurisdictionModal } from "@/app/components/modals/JurisdictionModal";
import { ModalSelect, SearchableChoiceModal } from "@/app/components/modals/ModalSelect";
import { WorkspaceHeader } from "@/app/components/shared/WorkspaceHeader";
import { MoreActionsMenu } from "@/app/components/shared/MoreActionsMenu";
import type { Document } from "@/app/components/shared/types";
import { Button, buttonClassName } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { TabList } from "@/app/components/ui/tabs";
import { Pagination } from "@/app/components/shared/TablePrimitive";
import { downloadBlob } from "@/app/lib/download";
import { cn, errorMessage } from "@/app/lib/utils";
import type { WorkProductMetadata } from "@/app/lib/workProducts";
import { captureCanliiDownload, chooseDownloadDirectory,
  type DownloadDirectory } from "./canliiCapture";
import type { AuthoritiesFile, AuthoritiesHost, AuthoritiesSourceIssue } from "./host";
import { AUTHORITIES_PROFILES, AUTHORITY_PROFILE_BY_ID, authoritiesProfile } from "./profiles";
import type { AuthoritiesAction, AuthoritiesBuildSettings, AuthoritiesProduct,
  AuthoritiesDiscrepancy, AuthoritiesProfileId,
  AuthorityIdentity, AuthorityKind, AuthorityOccurrence } from "./types";

type WorkspaceTab = "automatic" | "manual" | "drafts" | "settings";
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
  { value: "drafts", label: "Drafts" }, { value: "settings", label: "Settings" },
];
const AUTHORITY_JURISDICTIONS = [...new Map(AUTHORITIES_PROFILES.map(({ jurisdiction }) =>
  [jurisdiction.id, jurisdiction])).values()].sort((left, right) => left.order - right.order);
const GENERAL_PROFILE = authoritiesProfile("general");
const DEFAULTS: StartPreferences = {
  profileId: GENERAL_PROFILE.id, sourceMode: GENERAL_PROFILE.defaults.settings.sourceMode,
  passageMarking: GENERAL_PROFILE.defaults.settings.passageMarking,
};
const DRAFT_DATE = new Intl.DateTimeFormat("en-CA", { month: "long", day: "numeric",
  year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
type LibraryPicker = ComponentType<{ open: boolean; title: string; formatLabel: string;
  query: string; results: Document[]; busy: boolean; onQuery: (value: string) => void;
  onSelect: (document: Document) => void; onClose: () => void }>;
export type AuthoritiesRoute = { draftId: string; projectId?: string;
  replaceDraft: (draftId?: string) => void };
type ActionHandler = (action: AuthoritiesAction,
  done?: (next: AuthoritiesProduct) => void) => void;

export function AuthoritiesWorkspace({ host, headerActions, onDraftChange,
  refreshToken, locked = false, LibraryPicker, route, jurisdictionOrder = [] }: {
  host: AuthoritiesHost;
  route: AuthoritiesRoute;
  headerActions?: ReactNode;
  onDraftChange?: (draft: AuthoritiesProduct | undefined, synced: boolean) => void;
  refreshToken?: number;
  locked?: boolean;
  LibraryPicker?: LibraryPicker;
  jurisdictionOrder?: string[];
}) {
  const { draftId: requested, projectId, replaceDraft } = route;
  const routeTarget = useRef<string | null>(null), routeRequest = useRef(0);
  const [tab, setTab] = useState<WorkspaceTab>("automatic");
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const globalTab = tab === "drafts" || tab === "settings";
  const [preferences, setPreferences] = useState(loadPreferences);
  const [manualTitle, setManualTitle] = useState("Book of Authorities");
  const [drafts, setDrafts] = useState<WorkProductMetadata[]>([]);
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [draft, setDraft] = useState<AuthoritiesProduct>();
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(!!requested), [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState("");
  const [building, setBuilding] = useState(false);
  const [message, setMessage] = useState(""), [error, setError] = useState("");
  const [libraryOpen, setLibraryOpen] = useState(false), [addOpen, setAddOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<PendingImport>();
  const [query, setQuery] = useState(""), [results, setResults] = useState<Document[]>([]);
  const [searching, setSearching] = useState(false), [linkingId, setLinkingId] = useState("");
  const [focusRequest, setFocusRequest] = useState(0);
  const [downloadDirectory, setDownloadDirectory] = useState<DownloadDirectory | null>(null);
  const [outputFolder, setOutputFolder] = useState<string | null>(null);
  const [capturingId, setCapturingId] = useState("");
  const [sourceIssues, setSourceIssues] = useState<Record<string, AuthoritiesSourceIssue>>({});
  const [review, setReview] = useState<{ id: string; key: string;
    items: AuthoritiesDiscrepancy[]; error: string }>();
  const searchRequest = useRef<AbortController | null>(null), draftRef = useRef(draft);
  const buildRequest = useRef<AbortController | null>(null);
  const captureRequest = useRef<AbortController | null>(null);
  const reviewRequest = useRef<AbortController | null>(null);
  const actionQueue = useRef(Promise.resolve());
  const restoreScope = useRef(""), stayOnLanding = useRef(false);
  const refreshSeen = useRef(0), refreshRequest = useRef(0);
  draftRef.current = draft;

  const display = useCallback((next?: AuthoritiesProduct, preserveTab = false) => {
    captureRequest.current?.abort(); captureRequest.current = null; setCapturingId("");
    reviewRequest.current?.abort(); reviewRequest.current = null; setReview(undefined);
    draftRef.current = next; setDraft(next); setSelectedId(orderedOccurrences(next)[0]?.id ?? "");
    if (next) {
      if (!preserveTab) setTab(next.state.import.kind === "manual" ? "manual" : "automatic");
      setManualTitle(next.title);
    }
    setLinkingId(""); setError(""); setMessage("");
  }, []);
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
    if (restoreScope.current === scope || requested || draftsLoading || draftRef.current ||
        stayOnLanding.current) return;
    restoreScope.current = scope;
    const id = localStorage.getItem(lastDraftKey(projectId));
    if (!id || !drafts.some((item) => item.id === id)) return;
    setLoading(true);
    void host.drafts.get<AuthoritiesProduct["state"]>(id).then((next) => {
      remember(next); open(next);
    }).catch(() => localStorage.removeItem(lastDraftKey(projectId)))
      .finally(() => setLoading(false));
  }, [drafts, draftsLoading, host, projectId, requested]);

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
      display(next, tabRef.current === "drafts" || tabRef.current === "settings");
    }).catch((caught) => {
      if (request === routeRequest.current) setError(errorText(caught));
    }).finally(() => {
      if (request === routeRequest.current) setLoading(false);
    });
    return () => { routeRequest.current += 1; };
  }, [requested, projectId, display, host]);

  useEffect(() => {
    onDraftChange?.(draft, !!draft && !busy);
  }, [draft, busy, onDraftChange]);
  useEffect(() => localStorage.setItem("beaver.authorities.preferences", JSON.stringify(preferences)),
    [preferences]);
  useEffect(() => {
    let active = true;
    if (!host.outputFolder) { setOutputFolder(null); return () => { active = false; }; }
    void host.outputFolder.get().then((name) => active && setOutputFolder(name))
      .catch((caught) => active && setError(errorText(caught)));
    return () => { active = false; };
  }, [host]);
  useEffect(() => () => {
    searchRequest.current?.abort(); buildRequest.current?.abort(); captureRequest.current?.abort();
    reviewRequest.current?.abort();
  }, []);
  const draftId = draft?.id;
  const sourceKey = useMemo(() => draft ? JSON.stringify(draft.state.bindings) : "", [draft]);
  useEffect(() => {
    let active = true;
    const current = draftRef.current;
    if (!current || current.id !== draftId || !host.sourceIssues) {
      setSourceIssues({}); return () => { active = false; };
    }
    void host.sourceIssues(current).then((issues) => active && setSourceIssues(issues))
      .catch((caught) => active && setError(errorText(caught)));
    return () => { active = false; };
  }, [draftId, sourceKey, host]);
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
    if (refreshToken === undefined || refreshToken <= refreshSeen.current) return;
    refreshSeen.current = refreshToken; void refreshDraftEffect(refreshToken);
  }, [refreshToken]);

  const occurrences = useMemo(() => orderedOccurrences(draft), [draft]);
  const currentReview = review && draft && review.id === draft.id && review.key === reviewKey
    ? review : undefined;
  const discrepancies = currentReview?.items ?? [];
  const selected = occurrences.find(({ id }) => id === selectedId) ?? occurrences[0];
  const authorities = draft?.state.authorityOrder.flatMap((id) =>
    draft.state.authorities[id] ? [draft.state.authorities[id]] : []) ?? [];
  const missingPdfs = draft ? authorities.filter((item) => !item.excluded &&
    item.source.kind !== "attached" && missingSource(draft.state, item)) : [];
  const importedRole = draft?.state.import.kind === "document"
    ? draft.state.import.bindingRole : undefined;
  const importedIssue = importedRole ? sourceIssues[importedRole] : undefined;
  const canWatchDownloads = authorities.some(({ excluded, source }) => !excluded &&
    source.kind === "pending-canlii") &&
    typeof window !== "undefined" && "showDirectoryPicker" in window;
  const reviewError = !globalTab ? currentReview?.error || "" : "";
  const status = error || message || reviewError;
  const busyText = building ? "Building outputs" : pendingImport ? "Finding citations"
    : operation || "Updating authorities";

  function remember(next: AuthoritiesProduct) {
    draftRef.current = next; setDraft(next);
    localStorage.setItem(lastDraftKey(projectId), next.id);
    setDrafts((current) => [metadata(next), ...current.filter(({ id }) => id !== next.id)]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  function open(next?: AuthoritiesProduct) {
    stayOnLanding.current = false;
    display(next); routeTarget.current = next?.id ?? "";
    replaceDraft(next?.id);
  }
  function newDraft(forget = true) {
    stayOnLanding.current = true;
    if (forget) localStorage.removeItem(lastDraftKey(projectId));
    display(); routeTarget.current = ""; replaceDraft();
  }
  function changeTab(next: WorkspaceTab) {
    if ((next === "automatic" && draft?.state.import.kind === "manual") ||
        (next === "manual" && draft?.state.import.kind === "document")) newDraft(false);
    setTab(next); setError(""); setMessage(""); setLinkingId("");
  }
  async function run<T>(operationFn: () => Promise<T>, done: (value: T) => void,
    success = "", label = "Updating authorities") {
    if (busy) return;
    captureRequest.current?.abort(); captureRequest.current = null; setCapturingId("");
    setBusy(true); setOperation(label); setError(""); setMessage("");
    try { const value = await operationFn(); done(value); if (success) setMessage(success); }
    catch (caught) {
      if ((caught as { name?: string })?.name === "AbortError") setMessage("Build cancelled");
      else setError(errorText(caught));
    }
    finally { setBusy(false); setOperation(""); }
  }
  const act: ActionHandler = (action, done) => {
    const targetId = draftRef.current?.id;
    if (!targetId) return;
    actionQueue.current = actionQueue.current.then(async () => {
      const current = draftRef.current;
      if (!current || current.id !== targetId) return;
      const prior = "occurrenceId" in action
        ? current.state.occurrences[action.occurrenceId] : null;
      try {
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
        done?.(next);
      } catch (caught) { setError(errorText(caught)); }
    });
  };

  function queueDocument(document: Document) {
    setLibraryOpen(false); setError(""); setMessage("");
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
  function appendManual(files: AuthoritiesFile[]) {
    const pdfs = files.filter(({ file }) => file.type === "application/pdf" ||
      file.name.toLowerCase().endsWith(".pdf"));
    if (!pdfs.length) { setError("Add one or more PDFs."); return; }
    void run(async () => {
      let current = draft?.state.import.kind === "manual" ? draft : await host.create({
        source: { kind: "manual" }, title: manualTitle.trim() || "Book of Authorities",
        projectId, settings: { ...preferences, sourceMode: "manual-originals",
          passageMarking: "none", outputMode: "book" },
      });
      if (current !== draft) { remember(current); open(current); }
      for (let index = 0; index < pdfs.length; index += 1) {
        const selected = pdfs[index], before = new Set(current.state.authorityOrder);
        const label = selected.file.name.replace(/\.pdf$/iu, "").replace(/[_-]+/gu, " ").trim()
          || `Authority ${index + 1}`;
        setMessage(`Adding ${index + 1} of ${pdfs.length}`);
        current = await host.act(current.id, current.revision,
          { type: "add-authority", kind: "other", citation: label, name: label });
        remember(current);
        const authorityId = current.state.authorityOrder.find((id) => !before.has(id));
        if (!authorityId) throw new Error("The PDF could not be added.");
        current = await host.attach(current.id, authorityId, current.revision, selected);
        remember(current);
      }
      return current;
    }, (next) => { remember(next); open(next); }, `${pdfs.length} PDF${pdfs.length === 1 ? "" : "s"} added`);
  }
  function attach(authorityId: string, selected?: AuthoritiesFile) {
    if (!draft || !selected) return;
    void run(() => host.attach(draft.id, authorityId, draft.revision, selected), remember,
      `${selected.file.name} attached`);
  }
  function attachBookFiles(slot: "cover" | "index",
    selected: AuthoritiesFile[]) {
    if (!draft || !host.attachBookPdf || !selected.length) return;
    const files = selected.slice(0, 1);
    void run(async () => {
      let current = draft;
      for (let index = 0; index < files.length; index += 1) {
        setMessage(files.length > 1 ? `Adding ${index + 1} of ${files.length}` : "Adding file");
        current = await host.attachBookPdf!(current.id, current.revision, slot, files[index]);
        remember(current);
      }
      return current;
    }, remember, files.length > 1 ? `${files.length} files added` : `${files[0].file.name} added`);
  }
  function relinkSource(role: string) {
    if (!draft || !host.relinkSource) return;
    void run(() => host.relinkSource!(draft.id, role, draft.revision), (next) => {
      remember(next); setSourceIssues((current) => {
        const updated = { ...current }; delete updated[role]; return updated;
      });
    }, "Source relinked");
  }
  function replaceSource(selected?: AuthoritiesFile) {
    if (!draft || !selected || !host.replaceSource) return;
    void run(() => host.replaceSource!(draft.id, draft.revision, selected), (next) => {
      remember(next); setSourceIssues({});
    }, "Source replaced");
  }
  async function watchDownloads() {
    try {
      const directory = await chooseDownloadDirectory();
      if (directory) { setDownloadDirectory(directory); setMessage("Download folder connected"); }
    } catch (caught) {
      if ((caught as { name?: string })?.name !== "AbortError") setError(errorText(caught));
    }
  }
  function captureDownload(authority: AuthorityIdentity) {
    if (!downloadDirectory || authority.source.kind !== "pending-canlii") return;
    const url = authority.source.pdfUrl;
    captureRequest.current?.abort();
    const request = new AbortController(); captureRequest.current = request;
    const opened = window.open("about:blank", "_blank");
    if (opened) opened.opener = null;
    setCapturingId(authority.id); setError(""); setMessage("Waiting for the downloaded PDF");
    void captureCanliiDownload(downloadDirectory, url,
      { signal: request.signal, handoff: () => {
        if (!opened) throw new Error("Allow the CanLII tab, then try again.");
        opened.location.replace(url);
      } }).then((file) => {
      if (request.signal.aborted) return;
      captureRequest.current = null; setCapturingId("");
      if (!file) { setError("Download not found. Use Add PDF to attach it."); return; }
      const current = draftRef.current;
      if (!current) return;
      void run(() => host.attach(current.id, authority.id, current.revision, { file }), remember,
        `${file.name} attached`);
    }).catch((caught) => {
      if (captureRequest.current === request) {
        captureRequest.current = null; setCapturingId("");
      }
      if ((caught as { name?: string })?.name !== "AbortError") {
        opened?.close(); setError(errorText(caught));
      }
    });
  }
  function rename(title: string) {
    if (draft) void run(() => host.drafts.update<AuthoritiesProduct["state"]>(draft.id,
      { revision: draft.revision, title }), (next) => { remember(next); setManualTitle(next.title); });
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
  function build() {
    if (!draft) return;
    const request = new AbortController(); buildRequest.current = request; setBuilding(true);
    void run(async () => {
      setMessage("Finding source PDFs");
      const prepared = await host.prepareSources(draft, request.signal);
      remember(prepared);
      const required = prepared.state.authorityOrder.map((id) => prepared.state.authorities[id])
        .filter((authority) => authority && !authority.excluded &&
          authority.source.kind !== "attached" && mustAttachPdf(prepared.state, authority));
      if (required.length) throw new Error(
        `Attach a source PDF for ${authorityName(required[0])} before building.`,
      );
      return host.build(prepared, setMessage, request.signal);
    },
      ({ product, notice }) => { remember(product); setMessage(notice || "Outputs ready"); }).finally(() => {
        if (buildRequest.current === request) {
          buildRequest.current = null; setBuilding(false);
        }
      });
  }
  function chooseOutputFolder() {
    if (host.outputFolder) void run(() => host.outputFolder!.choose(), setOutputFolder);
  }
  function clearOutputFolder() {
    if (host.outputFolder) void run(() => host.outputFolder!.clear(), () => setOutputFolder(null));
  }
  function download(documentId: string, versionId: string, filename: string) {
    void host.download(documentId, versionId).then((blob) => downloadBlob(blob, filename))
      .catch((caught) => setError(errorText(caught)));
  }
  function selectOccurrence(id: string) {
    if (!linkingId || !draft) { setSelectedId(id); return; }
    if (busy) return;
    const target = draft.state.occurrences[id], source = draft.state.occurrences[linkingId];
    if (!target?.authorityId || target.id === source?.id) {
      setError("Choose the full citation this cross-reference points to."); return;
    }
    const kind = /\bibid\b/iu.test(source?.text ?? "") ? "ibid" : "supra";
    const sourceId = linkingId;
    act({ type: "set-reference", occurrenceId: sourceId,
      reference: { kind, targetAuthorityId: target.authorityId } }, () => {
      setLinkingId(""); setSelectedId(sourceId); setFocusRequest((value) => value + 1);
    });
  }

  return <div className={cn("authorities-workspace bg-app-background [scrollbar-gutter:stable]",
    host.mode === "standalone" ? "min-h-dvh" : "h-full min-h-0 overflow-y-auto")}>
    {draft && !globalTab ? <WorkspaceHeader className={host.mode === "standalone" ? "max-w-[50rem]" : "w-full"} current={draft}
        busy={busy || locked} itemLabel="authorities draft"
        onBack={() => newDraft(false)} onRename={rename} onDuplicate={duplicate}
        onDelete={removeDraft} headerActions={<><Button type="button" variant="outline"
          className="h-9 border-gray-400" disabled={busy || locked} onClick={() => newDraft()}>
          <Plus /> New</Button>{headerActions}</>} />
        : <WorkspaceHeader className={host.mode === "standalone" ? "max-w-[50rem]" : "w-full"} title="Authorities"
          headerActions={headerActions} />}
    <div inert={locked} aria-busy={locked || undefined}>
          <main className="mx-auto min-h-80 max-w-[50rem] px-4 py-4 sm:px-6">
        <TabList value={tab} onValueChange={changeTab} options={TABS}
          ariaLabel="Authorities sections" variant="dock" panelId="authorities-panel"
          className="mb-1 min-h-0 border-0 bg-transparent px-0 py-0 sm:px-0 max-[22rem]:[&_.tab-list]:justify-between max-[22rem]:[&_.tab-list]:gap-0 max-[22rem]:[&_[role=tab]]:px-1 max-[22rem]:[&_[role=tab]]:text-xs" />
        <Status busy={busy || !!capturingId}
          busyText={busyText} status={status} error={!!(error || (!message && reviewError))} />
        <div id="authorities-panel" role="tabpanel"
          aria-labelledby={`authorities-panel-tab-${TABS.findIndex(({ value }) => value === tab)}`}>
        {loading ? <Loading /> : tab === "drafts"
          ? <DraftsPanel drafts={drafts} loading={draftsLoading} busy={busy} onOpen={(id) => void run(
              () => host.drafts.get<AuthoritiesProduct["state"]>(id), (next) => {
                remember(next); open(next);
              }, "", "Opening draft")} />
          : tab === "settings"
            ? <StartSettings value={preferences} onChange={setPreferences} busy={busy}
                jurisdictionOrder={jurisdictionOrder}
                outputFolder={host.outputFolder ? outputFolder : undefined}
                onChooseFolder={host.outputFolder ? chooseOutputFolder : undefined}
                onClearFolder={host.outputFolder ? clearOutputFolder : undefined} />
            : !draft
              ? tab === "manual"
                ? <ManualStart title={manualTitle} busy={busy} onTitle={setManualTitle}
                    preferences={preferences} onPreferences={setPreferences}
                    jurisdictionOrder={jurisdictionOrder}
                    onPick={host.pickFiles ? () => void pickFiles(true, "pdf", appendManual) : undefined}
                    onFiles={(files) => appendManual(files.map((file) => ({ file })))} />
                : <AutomaticStart busy={busy}
                    onPick={host.pickFiles ? () => void pickFiles(false, "source",
                      (files) => queueFile(files[0])) : undefined}
                    onFile={(file) => queueFile(file && { file })}
                    onLibrary={host.searchLibrary && LibraryPicker
                      ? () => { setLibraryOpen(true); search(""); } : undefined} />
              : draft.state.import.kind === "manual"
                ? <><ManualDraft draft={draft} authorities={authorities} busy={busy}
                    sourceIssues={sourceIssues}
                    onAction={act} onAdd={() => setAddOpen(true)}
                    canWatch={canWatchDownloads} watching={!!downloadDirectory}
                    capturingId={capturingId} onWatch={() => void watchDownloads()}
                    onCanlii={captureDownload}
                    onPickMany={host.pickFiles ? () => void pickFiles(true, "pdf", appendManual) : undefined}
                    onFiles={(files) => appendManual(files.map((file) => ({ file })))}
                    onPick={host.pickFiles ? (id) => void pickFiles(false, "pdf",
                      (files) => attach(id, files[0])) : undefined}
                    onAttach={(id, file) => attach(id, file && { file })}
                    onRelink={(role) => relinkSource(role)} />
                  <BuildPanel draft={draft} busy={busy} building={building}
                    jurisdictionOrder={jurisdictionOrder}
                    missing={missingPdfs.length}
                    onAction={act}
                    sourceIssues={sourceIssues} onRelink={relinkSource}
                    onBookFiles={(slot, files) => attachBookFiles(slot,
                      files.map((file) => ({ file })))}
                    onPickBook={host.pickFiles ? (slot, multiple) => void pickFiles(
                      multiple, "pdf", (files) => attachBookFiles(slot, files)) : undefined}
                    onBuild={build} onCancel={() => buildRequest.current?.abort()}
                    onDownload={download} /></>
                : <><section className="rounded-xl border border-gray-300 bg-white shadow-sm">
                    <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-gray-200 px-4 py-3">
                      <div className="min-w-0"><h2 className="font-semibold text-gray-950">Import and review</h2>
                        <p className="truncate text-sm text-gray-600" title={draft.state.import.filename}>
                          {draft.state.import.filename}</p></div>
                      <div className="flex shrink-0 flex-wrap justify-end gap-2">
                        {importedRole && importedIssue && host.relinkSource &&
                          relinkable(importedIssue) && <Button type="button"
                          variant="outline" className="h-9 border-gray-400" disabled={busy}
                          onClick={() => relinkSource(importedRole)}><FilePlus2 />
                          {sourceAction(importedIssue, "source")}</Button>}
                        {host.replaceSource && (host.pickFiles
                          ? <Button type="button" variant="outline" className="h-9 border-gray-400"
                              disabled={busy} onClick={() => void pickFiles(false, "source",
                                (files) => replaceSource(files[0]))}><FilePlus2 /> Replace file</Button>
                          : <FileInputButton multiple={false} disabled={busy} label="Replace file"
                              accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                              onFiles={(files) => replaceSource(files[0] && { file: files[0] })}
                              variant="outline" compact />)}
                      </div>
                    </div>
                    <CitationReview occurrences={occurrences} units={draft.state.units}
                      selected={selected} authorities={authorities} discrepancies={discrepancies}
                      busy={busy} linkingId={linkingId} focusRequest={focusRequest}
                      onCancelLink={() => setLinkingId("")}
                      onSelect={selectOccurrence} onAction={act}
                      onBeginLink={(id) => { setError(""); setLinkingId(id); }} />
                  </section>
                  <BuildPanel draft={draft} busy={busy} building={building}
                    jurisdictionOrder={jurisdictionOrder}
                    missing={missingPdfs.length}
                    onAction={act}
                    sourceIssues={sourceIssues} onRelink={relinkSource}
                    onBookFiles={(slot, files) => attachBookFiles(slot,
                      files.map((file) => ({ file })))}
                    onPickBook={host.pickFiles ? (slot, multiple) => void pickFiles(
                      multiple, "pdf", (files) => attachBookFiles(slot, files)) : undefined}
                    onBuild={build} onCancel={() => buildRequest.current?.abort()}
                    onDownload={download} />
                  <Sources key={draft.id} draft={draft} authorities={authorities} busy={busy}
                    occurrences={occurrences} sourceIssues={sourceIssues} onAction={act}
                    canWatch={canWatchDownloads} watching={!!downloadDirectory}
                    capturingId={capturingId} onWatch={() => void watchDownloads()}
                    onCanlii={captureDownload} forceOpen={!!error}
                    onAdd={() => setAddOpen(true)}
                    onPick={host.pickFiles ? (id) => void pickFiles(false, "pdf",
                      (files) => attach(id, files[0])) : undefined}
                    onAttach={(id, file) => attach(id, file && { file })}
                    onRelink={relinkSource} /></>}
        </div>
      </main>
      {LibraryPicker && <LibraryPicker open={libraryOpen} title="Choose source document" formatLabel="PDF or Word"
        query={query} results={results} busy={searching} onQuery={search}
        onSelect={queueDocument} onClose={() => {
          searchRequest.current?.abort(); setLibraryOpen(false);
        }} />}
      <ImportSetup pending={pendingImport} busy={busy} status={error}
        jurisdictionOrder={jurisdictionOrder}
        onChange={(next) => setPendingImport((current) => current
          ? { ...current, preferences: next } : current)}
        onClose={() => { if (!busy) setPendingImport(undefined); }} onImport={importDocument} />
      <AddAuthorityModal open={addOpen} busy={busy} onClose={() => setAddOpen(false)}
        onAdd={(kind, citation, name) => {
          act({ type: "add-authority", kind, citation, name }); setAddOpen(false);
        }} />
    </div>
  </div>;

  function search(value: string) {
    searchRequest.current?.abort();
    const request = new AbortController(); searchRequest.current = request;
    setQuery(value); setSearching(true);
    void host.searchLibrary?.(value, request.signal)
      .then((items) => { if (!request.signal.aborted) setResults(items); })
      .catch((caught) => {
        if ((caught as { name?: string })?.name !== "AbortError") setError(errorText(caught));
      }).finally(() => {
        if (searchRequest.current === request) { searchRequest.current = null; setSearching(false); }
      });
  }
}

function Loading() {
  return <div className="grid h-80 place-items-center rounded-xl border border-gray-300 bg-white text-sm text-gray-600" role="status">
    <span className="inline-flex items-center"><Loader2 className="mr-2 h-4 w-4 motion-safe:animate-spin" /> Loading authorities</span>
  </div>;
}

function AutomaticStart({ busy, onFile, onPick, onLibrary }: {
  busy: boolean; onFile: (file?: File) => void;
  onPick?: () => void; onLibrary?: () => void;
}) {
  return <section className="rounded-xl border border-gray-300 bg-white p-4 shadow-sm sm:p-5">
    <div className="flex items-center gap-3"><Scale className="h-6 w-6 shrink-0 text-red-700" aria-hidden="true" />
      <div className="min-w-0"><h2 className="font-semibold text-gray-950">Import and review</h2>
        <p className="text-sm text-gray-600">Add a factum, brief, or other PDF or Word document.</p></div></div>
    <div className="mt-5 flex flex-wrap gap-2">
      {onPick ? <Button type="button" disabled={busy} onClick={onPick}>
        <FilePlus2 /> Add file</Button> : <FileInputButton multiple={false} disabled={busy}
          label="Add file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onFiles={(files) => onFile(files[0])} />}
      {onLibrary && <Button type="button" variant="outline" className="border-gray-400"
        disabled={busy} onClick={onLibrary}><FolderSearch /> Library</Button>}
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
    className="h-auto max-h-[calc(100dvh-2rem)]"
    footerStatus={status && <span className="text-sm text-red-800" role="status">{status}</span>}
    cancelAction={{ label: "Cancel", disabled: busy, onClick: onClose }}
    primaryAction={{ label: busy ? "Finding citations" : "Import and review", disabled: busy,
      icon: busy ? <Loader2 className="motion-safe:animate-spin" /> : undefined,
      onClick: onImport }}>
    <p className="mb-4 truncate text-sm text-gray-600" title={pending?.title}>{pending?.title}</p>
    <AuthoritiesCourtField value={value.profileId} disabled={busy}
      preferredKeys={jurisdictionOrder}
      onChange={(profileId) => onChange({ ...value, profileId })} />
    <OptionCards legend="Source handling" value={value.sourceMode} options={SOURCE_OPTIONS} disabled={busy}
      className="mt-5"
      onChange={(sourceMode) => onChange({ ...value, sourceMode })} />
    <OptionCards className="mt-5" legend="Passage marking" value={value.passageMarking}
      options={PASSAGE_OPTIONS} columns disabled={busy}
      onChange={(passageMarking) => onChange({ ...value, passageMarking })} />
    <div className="h-5" />
  </Modal>;
}

function ManualStart({ title, busy, preferences, jurisdictionOrder,
  onTitle, onPreferences, onPick, onFiles }: {
  title: string; busy: boolean; onTitle: (value: string) => void;
  preferences: StartPreferences; jurisdictionOrder: string[];
  onPreferences: (value: StartPreferences) => void;
  onPick?: () => void; onFiles: (files: File[]) => void;
}) {
  return <section className="rounded-xl border border-gray-300 bg-white p-4 shadow-sm sm:p-5">
    <div className="flex items-center gap-3"><BookOpen className="h-6 w-6 shrink-0 text-red-700" aria-hidden="true" />
      <div className="min-w-0"><h2 className="font-semibold text-gray-950">Build a book from PDFs</h2>
        <p className="text-sm text-gray-600">Add the authorities in the order you want them.</p></div></div>
    <label className="mt-5 block text-sm font-medium text-gray-800">Book title
      <Input value={title} onChange={(event) => onTitle(event.target.value)}
        className="mt-1 h-10 border-gray-400 md:text-base" /></label>
    <AuthoritiesCourtField value={preferences.profileId} disabled={busy}
      preferredKeys={jurisdictionOrder} className="mt-4 w-full"
      onChange={(profileId) => onPreferences({ ...preferences, profileId })} />
    <div className="mt-4">
        {onPick ? <Button type="button" className="h-11" disabled={busy} onClick={onPick}>
        <FilePlus2 /> Add files</Button> : <FileInputButton multiple disabled={busy}
          label="Add files" accept=".pdf,application/pdf" onFiles={onFiles} />}
    </div>
  </section>;
}

function DraftsPanel({ drafts, loading, busy, onOpen }: { drafts: WorkProductMetadata[];
  loading: boolean; busy: boolean; onOpen: (id: string) => void }) {
  const pages = Math.max(1, Math.ceil(drafts.length / 8));
  const [requestedPage, setPage] = useState(1), page = Math.min(requestedPage, pages);
  return <section className="overflow-hidden rounded-xl border border-gray-300 bg-white shadow-sm">
    <div className="flex min-h-16 items-center gap-3 border-b border-gray-200 px-4 py-3">
      <History className="h-5 w-5 shrink-0 text-red-700" /><div className="min-w-0"><h2 className="font-semibold text-gray-950">Saved drafts</h2>
      <p className="text-sm text-gray-600">Reopen, edit, and build again.</p></div></div>
    <div className="h-[28rem] overflow-y-auto">
      {loading ? <div className="grid h-full place-items-center px-4 py-12 text-sm text-gray-500"
        role="status"><span className="inline-flex items-center"><Loader2
          className="mr-2 h-4 w-4 motion-safe:animate-spin" />Loading saved drafts</span></div>
        : drafts.slice((page - 1) * 8, page * 8).map((item) => <button key={item.id} type="button" disabled={busy}
        onClick={() => onOpen(item.id)} className="grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-gray-100 px-4 text-left outline-none last:border-0 hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600">
        <span className="min-w-0"><span className="block truncate text-sm font-medium text-gray-950">{item.title}</span>
          <span className="block text-xs text-gray-500">{formatDraftDate(item.updatedAt)}</span></span>
        <ChevronRight className="h-4 w-4 text-gray-500" />
      </button>)}
      {!loading && !drafts.length && <p className="grid h-full place-items-center px-4 py-12 text-center text-sm text-gray-500">No saved drafts yet.</p>}
    </div>
    {!loading && !!drafts.length && <Pagination page={page} pages={pages}
      label={`${drafts.length} authorities drafts`} disabled={busy} onPage={setPage} />}
  </section>;
}

function formatDraftDate(iso: string) {
  const parts = Object.fromEntries(DRAFT_DATE.formatToParts(new Date(iso))
    .map(({ type, value }) => [type, value]));
  return `${parts.month} ${parts.day}, ${parts.year} ${parts.hour}:${parts.minute} ${parts.dayPeriod.replaceAll(".", "").toUpperCase()}`;
}

function AuthoritiesCourtField({ value, disabled, preferredKeys, onChange, className }: {
  value: AuthoritiesProfileId; disabled?: boolean; preferredKeys: string[];
  onChange: (value: AuthoritiesProfileId) => void; className?: string;
}) {
  const current = authoritiesProfile(value);
  const [dialog, setDialog] = useState<"jurisdiction" | "profile">();
  const [jurisdictionId, setJurisdictionId] = useState(current.jurisdiction.id);
  const profiles = AUTHORITIES_PROFILES.filter(({ jurisdiction }) =>
    jurisdiction.id === jurisdictionId);
  useEffect(() => setJurisdictionId(current.jurisdiction.id), [current.jurisdiction.id]);

  function chooseJurisdiction(id: string) {
    const choices = AUTHORITIES_PROFILES.filter(({ jurisdiction }) => jurisdiction.id === id);
    setJurisdictionId(id);
    if (choices.length === 1) { onChange(choices[0].id); setDialog(undefined); }
    else setDialog("profile");
  }

  return <div className={className}>
    <ChoiceModalButton icon={<Scale aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-500" />}
      label="Court" value={current.label} disabled={disabled} className="w-full"
      onClick={() => setDialog("jurisdiction")} />
    <JurisdictionModal open={dialog === "jurisdiction"} value={current.jurisdiction.id}
      options={AUTHORITY_JURISDICTIONS.map(({ id, label, preferenceKey }) =>
        ({ value: id, label, preferenceKey }))}
      preferredKeys={preferredKeys} onChange={chooseJurisdiction}
      onClose={() => setDialog((open) => open === "jurisdiction" ? undefined : open)} />
    <SearchableChoiceModal open={dialog === "profile"} title="Choose court"
      value={value} searchable={profiles.length > 8} size="2xl"
      options={profiles.map(({ id, label }) => ({ value: id, label }))}
      onChange={(id) => { if (id) onChange(id); setDialog(undefined); }}
      onClose={() => setDialog(undefined)} />
  </div>;
}

function StartSettings({ value, onChange, busy, jurisdictionOrder,
  outputFolder, onChooseFolder, onClearFolder }: {
  value: StartPreferences; onChange: (value: StartPreferences) => void; busy: boolean;
  jurisdictionOrder: string[];
  outputFolder?: string | null; onChooseFolder?: () => void; onClearFolder?: () => void;
}) {
  return <section className="rounded-xl border border-gray-300 bg-white p-4 shadow-sm sm:p-5">
    <div className="flex items-center gap-3"><Settings2 className="h-5 w-5 shrink-0 text-red-700" />
      <div className="min-w-0"><h2 className="font-semibold text-gray-950">New drafts</h2>
        <p className="text-sm text-gray-600">Defaults used when you import a document.</p></div></div>
    <div className="mt-5 grid gap-4 sm:grid-cols-2">
      <AuthoritiesCourtField value={value.profileId} disabled={busy}
        preferredKeys={jurisdictionOrder}
        onChange={(profileId) => onChange({ ...value, profileId })} />
      <SelectField label="Source handling" value={value.sourceMode}
        onChange={(sourceMode) => onChange({ ...value, sourceMode })}
        options={SOURCE_OPTIONS} />
      <SelectField label="Passage marking" value={value.passageMarking}
        onChange={(passageMarking) => onChange({ ...value, passageMarking })}
        options={PASSAGE_OPTIONS} />
    </div>
    {onChooseFolder && <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 pt-4">
      <div className="min-w-0"><h3 className="text-sm font-semibold text-gray-950">Output folder</h3>
        <p className="truncate text-sm text-gray-600">{outputFolder || "Not set"}</p></div>
      <div className="ms-auto flex items-center gap-2">
        {outputFolder && <Button type="button" variant="ghost" className="h-9"
          disabled={busy} onClick={onClearFolder}>Clear</Button>}
        <Button type="button" variant="outline" className="h-9 border-gray-400"
          disabled={busy} onClick={onChooseFolder}><FolderSearch /> Choose folder</Button>
      </div>
    </div>}
  </section>;
}

function ManualDraft({ draft, authorities, busy, sourceIssues,
  onAction, onAdd, onPickMany, onFiles, onPick, onAttach, onRelink,
  canWatch, watching, capturingId, onWatch, onCanlii }: {
  draft: AuthoritiesProduct; authorities: AuthorityIdentity[]; busy: boolean;
  sourceIssues: Record<string, AuthoritiesSourceIssue>;
  onAction: (action: AuthoritiesAction) => void;
  onAdd: () => void; onPickMany?: () => void; onFiles: (files: File[]) => void;
  onPick?: (id: string) => void; onAttach: (id: string, file?: File) => void;
  onRelink: (role: string) => void;
  canWatch: boolean; watching: boolean; capturingId: string; onWatch: () => void;
  onCanlii: (authority: AuthorityIdentity) => void;
}) {
  return <section className="rounded-xl border border-gray-300 bg-white p-4 shadow-sm"
    onDragOver={(event) => event.dataTransfer.types.includes("Files") && event.preventDefault()}
    onDrop={(event) => {
      const files = Array.from(event.dataTransfer.files);
      if (files.length) { event.preventDefault(); onFiles(files); }
    }}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="font-semibold text-gray-950">Authorities</h2>
        <p className="text-sm tabular-nums text-gray-600">{pdfCount(authorities)} PDF{pdfCount(authorities) === 1 ? "" : "s"}</p></div>
      <div className="flex flex-wrap justify-end gap-2">
        <CanliiWatchButton available={canWatch} watching={watching} busy={busy} onClick={onWatch} />
        {onPickMany ? <Button type="button" variant="outline" className="h-10 border-gray-400"
          disabled={busy} onClick={onPickMany}><FilePlus2 /> Add files</Button>
          : <FileInputButton multiple disabled={busy} label="Add files" accept=".pdf,application/pdf"
            onFiles={onFiles} variant="outline" />}
      </div>
    </div>
    <div className="mt-4 max-h-[28rem] space-y-1.5 overflow-y-auto [scrollbar-gutter:stable]">
      {authorities.map((authority, index) => {
        const role = attachedRole(authority);
        return <AuthorityRow key={authority.id}
        authority={authority} index={index} tabStyle={draft.state.settings.tabStyle} busy={busy}
        citations={[authority.citation]}
        needsPdf
        removable onAction={onAction} onPick={onPick ? () => onPick(authority.id) : undefined}
        issue={role ? sourceIssues[role] : undefined}
        onRelink={role && relinkable(sourceIssues[role]) ? () => onRelink(role) : undefined}
        capturing={capturingId === authority.id}
        onCanlii={watching ? () => onCanlii(authority) : undefined}
        onAttach={(file) => onAttach(authority.id, file)} />;
      })}
      {!authorities.length && <p className="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500">Add PDF files to begin.</p>}
    </div>
    <Button type="button" variant="ghost" className="mt-2 h-9" disabled={busy} onClick={onAdd}>
      <Plus /> Add authority without a PDF</Button>
  </section>;
}

function Sources({ draft, authorities, occurrences, busy, sourceIssues, onAction, onAdd,
  onPick, onAttach, onRelink, canWatch, watching, capturingId, onWatch, onCanlii,
  forceOpen }: {
  draft: AuthoritiesProduct; authorities: AuthorityIdentity[]; occurrences: AuthorityOccurrence[];
  busy: boolean; sourceIssues: Record<string, AuthoritiesSourceIssue>;
  onAction: (action: AuthoritiesAction) => void; onAdd: () => void;
  onPick?: (id: string) => void; onAttach: (id: string, file?: File) => void;
  onRelink: (role: string) => void;
  canWatch: boolean; watching: boolean; capturingId: string; onWatch: () => void;
  onCanlii: (authority: AuthorityIdentity) => void; forceOpen: boolean;
}) {
  const needsPdf = authorities.some((authority) => requiresPdf(draft.state, authority));
  const intervention = forceOpen || Object.keys(sourceIssues).length > 0 || (needsPdf &&
    (authorities.some(({ excluded, source }) => !excluded && source.kind === "pending-canlii") ||
    (draft.state.settings.sourceMode === "manual-originals" &&
      authorities.some(({ excluded, source }) => !excluded && source.kind !== "attached")) ||
    authorities.some((authority) => !authority.excluded && requiresUnlinkedTablePdf(draft.state, authority) &&
      authority.source.kind !== "attached")));
  const [expanded, setExpanded] = useState(intervention);
  useEffect(() => { if (intervention) setExpanded(true); }, [intervention]);
  return <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}
    className="group mt-3 overflow-hidden rounded-xl border border-gray-300 bg-white shadow-sm">
    <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 px-4 outline-none hover:bg-gray-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="h-4 w-4 shrink-0 text-red-700 transition-transform group-open:rotate-90 motion-reduce:transition-none" />
      <h2 className="font-semibold text-gray-950">Sources</h2>
      <span className="ms-auto text-sm tabular-nums text-gray-500">{authorities.length}</span>
    </summary>
    <div className="border-t border-gray-200 px-4 pb-4 pt-3">
      {canWatch && <div className="flex min-h-8 items-center justify-end gap-2">
        <CanliiWatchButton available={canWatch} watching={watching} busy={busy} onClick={onWatch} />
      </div>}
      <div className={cn("max-h-[28rem] space-y-1.5 overflow-y-auto [scrollbar-gutter:stable]", canWatch && "mt-2")}>
      {authorities.map((authority, index) => {
        const role = attachedRole(authority);
        return <AuthorityRow key={authority.id}
        authority={authority} index={index} tabStyle={draft.state.settings.tabStyle} busy={busy}
        citations={authorityCitationForms(authority, occurrences)}
        needsPdf={requiresPdf(draft.state, authority)}
        removable={!occurrences.some(({ authorityId }) => authorityId === authority.id)}
        onAction={onAction} onPick={onPick ? () => onPick(authority.id) : undefined}
        issue={role ? sourceIssues[role] : undefined}
        onRelink={role && relinkable(sourceIssues[role]) ? () => onRelink(role) : undefined}
        capturing={capturingId === authority.id}
        onCanlii={watching ? () => onCanlii(authority) : undefined}
        onAttach={(file) => onAttach(authority.id, file)} />;
      })}
      </div>
      <Button type="button" variant="ghost" className="mt-2 h-9" disabled={busy} onClick={onAdd}>
        <Plus /> Add authority</Button>
    </div>
  </details>;
}

function CitationReview({ occurrences, units, selected, authorities, discrepancies, onSelect,
  onAction, onBeginLink, busy, linkingId, focusRequest, onCancelLink }: {
  occurrences: AuthorityOccurrence[]; selected?: AuthorityOccurrence;
  units: AuthoritiesProduct["state"]["units"]; authorities: AuthorityIdentity[];
  discrepancies: AuthoritiesDiscrepancy[]; busy: boolean; linkingId: string;
  focusRequest: number;
  onSelect: (id: string) => void; onAction: ActionHandler;
  onBeginLink: (id: string) => void; onCancelLink: () => void;
}) {
  const options = useRef<Array<HTMLButtonElement | null>>([]), previousLink = useRef("");
  useLayoutEffect(() => {
    if (linkingId || previousLink.current) {
      options.current[occurrences.findIndex(({ id }) => id === selected?.id)]?.focus();
    }
    previousLink.current = linkingId;
  }, [linkingId, occurrences, selected?.id, focusRequest]);
  if (!occurrences.length) return <div className="grid h-80 place-items-center text-sm text-gray-500">No citations found.</div>;
  const unit = units.find(({ id }) => id === selected?.unitId), unitText = unit?.text ?? selected?.text ?? "";
  const authorityById = new Map(authorities.map((item) => [item.id, item]));
  const findingByOccurrence = new Map(discrepancies.map((item) => [item.occurrenceId, item]));
  return <div className="authorities-review grid min-h-0 @min-[40rem]:h-80 @min-[40rem]:grid-cols-[18rem_minmax(0,1fr)]! @min-[40rem]:overflow-hidden">
    <div className="overflow-visible border-b border-gray-200 @min-[40rem]:overflow-y-auto @min-[40rem]:border-b-0 @min-[40rem]:border-e" role="listbox"
      aria-label="Citations" aria-describedby={linkingId ? "authority-link-instruction" : undefined}>
      {occurrences.map((item, index) => {
        const authority = item.authorityId ? authorityById.get(item.authorityId) : undefined;
        const finding = findingByOccurrence.get(item.id);
        return <button key={item.id} ref={(node) => { options.current[index] = node; }}
          type="button" role="option" aria-selected={item.id === selected?.id}
          aria-disabled={busy && !!linkingId || undefined}
          tabIndex={item.id === selected?.id ? 0 : -1} onClick={() => onSelect(item.id)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && linkingId) {
              event.preventDefault(); if (!busy) onCancelLink(); return;
            }
            if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? occurrences.length - 1
              : (index + (event.key === "ArrowDown" ? 1 : -1) + occurrences.length) % occurrences.length;
            if (!linkingId) onSelect(occurrences[next].id);
            options.current[next]?.focus();
          }} className={cn("block min-h-[3.6rem] w-full border-b border-s-4 border-gray-100 px-3 py-2 text-left outline-none focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-600", item.id === selected?.id ? "border-s-red-700 bg-red-50" : "border-s-transparent hover:bg-red-50")}>
          <span className="block text-xs text-gray-500">{location(item, index, occurrences, units)}</span>
          {authority && authorityName(authority) !== authority.citation &&
            <span className="block truncate text-sm font-semibold text-gray-900">{authorityName(authority)}</span>}
          <span className="block truncate text-xs text-gray-700">{item.citation}</span>
          {finding && <span className="block text-xs font-medium text-red-800">Source mismatch</span>}
        </button>;
      })}
    </div>
    {selected && <CitationEditor key={selected.id} selected={selected} unitText={unitText}
      footnote={unit?.kind === "footnote"} canMerge={(unit?.occurrenceIds.indexOf(selected.id) ?? 0) > 0}
      authorities={authorities} busy={busy} linking={linkingId === selected.id}
      finding={findingByOccurrence.get(selected.id)}
      onAction={onAction} onBeginLink={onBeginLink} onCancelLink={onCancelLink} />}
  </div>;
}

function CitationEditor({ selected, unitText, footnote, canMerge, authorities, finding, onAction,
  onBeginLink, busy, linking, onCancelLink }: {
  selected: AuthorityOccurrence; unitText: string; footnote: boolean; canMerge: boolean;
  authorities: AuthorityIdentity[]; onAction: ActionHandler; busy: boolean; linking: boolean;
  finding?: AuthoritiesDiscrepancy;
  onBeginLink: (id: string) => void; onCancelLink: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const linked = authorities.find(({ id }) => id === selected.reference?.targetAuthorityId);
  const rememberSelection = () => setSelection(selectionRange(surface.current));
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
  const actionClass = "h-auto min-h-10 min-w-0 whitespace-normal px-2 py-1.5 text-xs leading-tight @min-[40rem]:min-h-9 @min-[40rem]:whitespace-nowrap";
  return <div className="min-h-0 min-w-0 overflow-visible p-3 @min-[40rem]:overflow-y-auto [scrollbar-gutter:stable]">
    {finding && <SourceFinding finding={finding} />}
    <div ref={surface} contentEditable suppressContentEditableWarning role="textbox" aria-readonly="true"
      aria-multiline="true"
      aria-label={`${footnote ? "Footnote" : "In-text citation"} context`} spellCheck={false}
      onMouseUp={rememberSelection} onKeyUp={rememberSelection}
      onBeforeInput={(event) => event.preventDefault()} onPaste={(event) => event.preventDefault()}
      onDrop={(event) => event.preventDefault()} onKeyDown={(event) => {
        if ((!event.ctrlKey && !event.metaKey && event.key.length === 1) ||
            ["Backspace", "Delete", "Enter"].includes(event.key)) event.preventDefault();
      }} className="min-h-32 overflow-visible whitespace-pre-wrap rounded-lg border border-gray-300 bg-white px-3 py-12 text-sm leading-6 text-gray-800 outline-none focus-visible:ring-2 focus-visible:ring-red-600 @min-[40rem]:h-32 @min-[40rem]:min-h-0 @min-[40rem]:overflow-auto">{highlight(unitText, selected)}</div>
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
      <Button type="button" variant="outline" className={actionClass} disabled={busy}
        onClick={() => submit({ type: "remove-occurrence",
          occurrenceId: selected.id })}>Not a citation</Button>
    </div>
    <div className={cn("mt-2 grid min-h-16 grid-cols-2 items-center gap-2 border-t border-gray-200 pt-2 @min-[40rem]:flex @min-[40rem]:min-h-12",
      selected.kind !== "reference" && "invisible")} aria-hidden={selected.kind !== "reference" || undefined}
      inert={selected.kind !== "reference" ? true : undefined}>
      <span id={linking ? "authority-link-instruction" : undefined}
        className="col-span-2 min-w-0 truncate text-xs text-gray-500 @min-[40rem]:flex-1">
        {linking ? "Choose the full citation this cross-reference points to."
          : linked ? `Linked to ${authorityLabel(linked)}` : "Not linked"}
      </span>
      {linking ? <Button type="button" variant="outline"
        className="col-span-2 h-9 text-xs @min-[40rem]:col-span-1" disabled={busy}
        onClick={onCancelLink}>Cancel</Button> : <>
        <Button type="button" variant="outline" className="h-auto min-h-9 min-w-0 whitespace-normal px-2 text-xs leading-tight"
          disabled={busy} onClick={() => onBeginLink(selected.id)}>
          <Link2 /> Link to authority</Button>
        <Button type="button" variant="ghost" className="h-auto min-h-9 min-w-0 whitespace-normal px-2 text-xs leading-tight" disabled={busy || !selected.reference}
          onClick={() => submit({ type: "set-reference", occurrenceId: selected.id,
            reference: null })}>Clear link</Button>
      </>}
    </div>
  </div>;
}

function SourceFinding({ finding }: { finding: AuthoritiesDiscrepancy }) {
  const source = finding.found ?? finding.cited;
  return <section className="mb-2 rounded-lg border border-red-300 bg-red-50 p-2.5 text-xs text-gray-800">
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-1">
      <h3 className="font-semibold text-red-950">Source check</h3>
      <span className="text-red-800">{finding.kind === "wrong_pinpoint"
        ? `Quoted text appears at ${source.locator.kind} ${source.locator.label}`
        : `${finding.cited.locator.kind} ${finding.cited.locator.label} does not match`}</span>
    </div>
    <div className="grid gap-2 sm:grid-cols-2">
      <div><span className="font-medium text-gray-600">Authored</span>
        <p className="mt-0.5 whitespace-pre-wrap leading-5">{finding.authoredQuote}</p></div>
      <div><span className="font-medium text-gray-600">Source</span>
        <p className="mt-0.5 whitespace-pre-wrap leading-5">{source.text}</p></div>
    </div>
  </section>;
}

function CanliiWatchButton({ available, watching, busy, onClick }: {
  available: boolean; watching: boolean; busy: boolean; onClick: () => void;
}) {
  return available ? <Button type="button" variant="outline" className="h-8 border-gray-400 px-2.5 text-xs"
    aria-pressed={watching} disabled={busy} onClick={onClick}><FolderSearch />
    {watching ? "Change downloads folder" : "Connect downloads folder"}</Button> : null;
}

function AuthorityRow({ authority, index, tabStyle, citations, busy, onAction, removable, needsPdf,
  issue, onPick, onRelink, onAttach, onCanlii, capturing = false }: {
  authority: AuthorityIdentity; index: number;
  tabStyle: AuthoritiesBuildSettings["tabStyle"]; citations: string[]; busy: boolean;
  removable: boolean; needsPdf: boolean; onAction: (action: AuthoritiesAction) => void;
  issue?: AuthoritiesSourceIssue; onPick?: () => void; onRelink?: () => void;
  onCanlii?: () => void; capturing?: boolean;
  onAttach: (file?: File) => void;
}) {
  const [editing, setEditing] = useState(false), [name, setName] = useState(authorityName(authority));
  const replaceMissing = issue?.status === "missing" && issue.reason !== "permission";
  const attachedSource = authority.source.kind === "attached" && !replaceMissing
    ? authority.source : undefined;
  const title = authorityName(authority), citationLine = citations
    .filter((citation) => !title.toLocaleLowerCase().includes(citation.toLocaleLowerCase()))
    .join("; ");
  return <article className={cn("rounded-lg border bg-white px-2 py-1",
    authority.excluded ? "border-gray-200 opacity-65" : "border-gray-300")}
    onDragOver={(event) => {
      if (needsPdf && event.dataTransfer.types.includes("Files")) event.preventDefault();
    }} onDrop={(event) => {
      if (needsPdf && event.dataTransfer.files[0]) {
        event.preventDefault(); event.stopPropagation(); onAttach(event.dataTransfer.files[0]);
      } else if (event.dataTransfer.files.length) event.preventDefault();
    }}>
    <div className="grid grid-cols-[2.75rem_minmax(0,1fr)_2rem] items-center gap-x-1.5 gap-y-1 @min-[40rem]:grid-cols-[2.75rem_minmax(10rem,1fr)_minmax(8rem,18rem)_2rem]">
      <span className={cn("text-center text-[11px] font-semibold uppercase tabular-nums text-gray-500",
        needsPdf && "row-span-2 @min-[40rem]:row-span-1")}
        aria-label={`Tab ${automaticTab(index + 1, tabStyle)}`}>
        Tab {automaticTab(index + 1, tabStyle)}
      </span>
      <div className="min-w-0">{editing ? <form className="grid grid-cols-[minmax(0,1fr)_auto] gap-1" onSubmit={(event) => {
        event.preventDefault(); onAction({ type: "rename-authority", authorityId: authority.id,
        displayName: name.trim() || null }); setEditing(false);
      }}><Input autoFocus aria-label="Authority title" value={name}
          onChange={(event) => setName(event.target.value)} className="h-8 border-gray-400 text-sm" />
        <Button type="submit" className="h-8" disabled={busy}>Save</Button></form>
        : <><h3 className="truncate text-sm font-medium text-gray-950" title={title}>{title}</h3>
          {citationLine && <p className="truncate text-xs text-gray-500"
            title={citationLine}>{citationLine}</p>}</>}</div>
      {needsPdf && <div className="col-span-2 col-start-2 row-start-2 flex min-h-8 min-w-0 flex-wrap items-center gap-2 @min-[40rem]:col-span-1 @min-[40rem]:col-start-3 @min-[40rem]:row-start-1 @min-[40rem]:flex-nowrap">
        {authority.source.kind === "pending-canlii" && <a href={authority.source.pdfUrl}
          target="_blank" rel="noopener noreferrer" onClick={(event) => {
            if (onCanlii) { event.preventDefault(); onCanlii(); }
          }}
          className="inline-flex min-h-8 shrink-0 items-center rounded-md bg-red-700 px-2.5 text-xs font-medium text-white outline-none hover:bg-red-800 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2">
          {capturing && <Loader2 className="mr-1 h-3.5 w-3.5 motion-safe:animate-spin" />}
          {capturing ? "Waiting for download" : "Download from CanLII"}</a>}
        {attachedSource
          ? <><span className="min-w-0 flex-1 truncate text-xs text-gray-600" title={attachedSource.filename}>{attachedSource.filename}</span>
            {onPick ? <Button type="button" variant="outline" className="h-8 shrink-0 border-gray-400 px-2.5 text-xs"
              aria-label={`Replace PDF for ${authorityName(authority)}`} disabled={busy}
              onClick={onPick}>Replace</Button>
              : <FileInputButton multiple={false} disabled={busy} label="Replace"
                ariaLabel={`Replace PDF for ${authorityName(authority)}`}
                accept=".pdf,application/pdf" onFiles={(files) => onAttach(files[0])}
                variant="outline" compact />}</>
          : onPick ? <Button type="button" variant="outline" className="h-8 shrink-0 border-gray-400 px-2.5 text-xs"
            aria-label={`Add PDF for ${authorityName(authority)}`} disabled={busy}
            onClick={onPick}><FilePlus2 /> Add PDF</Button>
            : <FileInputButton multiple={false} disabled={busy} label="Add PDF"
              ariaLabel={`Add PDF for ${authorityName(authority)}`}
              accept=".pdf,application/pdf" onFiles={(files) => onAttach(files[0])} variant="outline" compact />}
        {issue && onRelink && <Button type="button" variant="outline" className="h-8 shrink-0 border-gray-400 px-2.5 text-xs"
          disabled={busy} onClick={onRelink}><FilePlus2 /> {sourceAction(issue, "PDF")}</Button>}
      </div>}
      <div className="col-start-3 row-start-1 @min-[40rem]:col-start-4">
        <MoreActionsMenu label={`Options for ${authorityName(authority)}`}
        triggerClassName="h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-red-600"
        items={[{ label: "Edit title", disabled: busy, onSelect: () => {
          setName(authorityName(authority)); setEditing(true);
         } }, ...(attachedSource ? [{ label: "Remove PDF", disabled: busy,
          onSelect: () => onAction({ type: "clear-authority-source", authorityId: authority.id }) }] : []),
        { label: authority.excluded ? "Include in book" : "Leave out of book",
          disabled: busy, onSelect: () => onAction({ type: "exclude-authority",
            authorityId: authority.id, excluded: !authority.excluded }) },
        { label: "Delete entry", disabled: busy || !removable,
          onSelect: () => onAction({ type: "remove-authority", authorityId: authority.id }) }]} />
      </div>
    </div>
  </article>;
}

function BuildPanel({ draft, busy, building, missing, jurisdictionOrder, onAction, sourceIssues,
  onRelink, onBookFiles, onPickBook, onBuild, onCancel, onDownload }: {
  draft: AuthoritiesProduct; busy: boolean; building: boolean; missing: number;
  jurisdictionOrder: string[];
  onAction: (action: AuthoritiesAction) => void; onBuild: () => void; onCancel: () => void;
  sourceIssues: Record<string, AuthoritiesSourceIssue>; onRelink: (role: string) => void;
  onBookFiles?: (slot: "cover" | "index", files: File[]) => void;
  onPickBook?: (slot: "cover" | "index", multiple: boolean) => void;
  onDownload: (documentId: string, versionId: string, filename: string) => void;
}) {
  const profile = authoritiesProfile(draft.state.settings.profileId);
  const lockedOutput = !!profile.locked?.outputMode;
  const book = draft.state.outputMode !== "table";
  const completeBook = book && !!profile.requirements?.completeBookSources;
  const filingMedia = profile.options?.filingMedium;
  const bookRoles = profile.options?.bookRole;
  const missingText = missing ? completeBook || lockedOutput
    ? `${missing} source PDF${missing === 1 ? " is" : "s are"} required before building.`
    : draft.state.settings.missingSourcePolicy === "placeholder"
    ? `${missing} missing source PDF${missing === 1 ? "" : "s"}: labelled pages will be added.`
    : `${missing} missing source PDF${missing === 1 ? "" : "s"}: those authorities will be left out of the book.`
    : "";
  return <section className="mt-3 rounded-xl border border-gray-300 bg-white p-4 shadow-sm">
    <h2 className="font-semibold text-gray-950">Build outputs</h2>
    <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_9rem] sm:items-end">
      <AuthoritiesCourtField value={draft.state.settings.profileId} disabled={busy}
        preferredKeys={jurisdictionOrder}
        onChange={(profileId) => onAction({ type: "set-profile", profileId })} />
      <SelectField label="Create" value={draft.state.outputMode} disabled={busy || lockedOutput}
        onChange={(outputMode) => onAction({ type: "set-output-mode", outputMode })}
        options={[{ value: "book", label: "Book of Authorities" },
          { value: "table", label: "Table of Authorities" }, { value: "both", label: "Book and Table" }]} />
      <Button type="button" className="h-10" disabled={busy && !building}
        onClick={building ? onCancel : onBuild}>
        {building ? <><Loader2 className="motion-safe:animate-spin" /> Cancel</>
          : <><BookOpen /> Build</>}</Button>
    </div>
    {book && filingMedia && bookRoles && <div className="mt-2 grid gap-3 sm:grid-cols-2">
      <SelectField label="Filing" value={draft.state.settings.filingMedium ?? "electronic"}
        disabled={busy} onChange={(filingMedium) => onAction({ type: "set-settings",
          settings: { filingMedium } })}
        options={filingMedia} />
      <SelectField label="Filed by" value={draft.state.settings.bookRole ?? bookRoles[0].value}
        disabled={busy} onChange={(bookRole) => onAction({ type: "set-settings",
          settings: { bookRole } })} options={bookRoles} />
    </div>}
    <p className={cn("mt-2 min-h-5 text-sm leading-5", missingText ? "text-red-800" : "invisible")}
      aria-hidden={!missingText || undefined}>{missingText || "Ready"}</p>
    {book && <BookContents draft={draft} busy={busy} onAction={onAction}
      sourceIssues={sourceIssues} onRelink={onRelink} onFiles={onBookFiles} onPick={onPickBook} />}
    <details className="group border-t border-gray-200 pt-2">
      <summary className="flex min-h-9 w-fit cursor-pointer list-none items-center gap-1 rounded-md px-1 text-sm font-medium text-red-700 outline-none hover:text-red-900 focus-visible:ring-2 focus-visible:ring-red-600 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="h-4 w-4 transition-transform group-open:rotate-90 motion-reduce:transition-none" /> Options</summary>
      <div className="grid gap-3 pb-2 pt-3 sm:grid-cols-2">
        {draft.state.import.kind === "document" && draft.state.outputMode !== "table" && <SelectField label="Source handling" value={draft.state.settings.sourceMode}
          disabled={busy} onChange={(sourceMode) => onAction({ type: "set-settings", settings: { sourceMode } })}
          options={SOURCE_OPTIONS} />}
        {draft.state.import.kind === "document" && draft.state.outputMode !== "table" && <SelectField label="Passage marking" value={draft.state.settings.passageMarking}
          disabled={busy} onChange={(passageMarking) => onAction({ type: "set-settings", settings: { passageMarking } })}
          options={PASSAGE_OPTIONS} />}
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
          <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md text-sm text-gray-800 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-red-600">
            <input type="checkbox" className="h-4 w-4 accent-red-700" disabled={busy}
              checked={draft.state.insertIntoDocument} onChange={(event) => onAction({
                type: "set-document-output", enabled: event.target.checked })} />
            Add the table to a Word copy
          </label>}
      </div>
    </details>
    <div className="min-h-12 border-t border-gray-200 pt-2">
      {Object.entries(draft.outputs).map(([role, output]) => <button key={role} type="button"
        aria-label={`Download ${output.filename}`} title={output.filename}
        onClick={() => onDownload(output.documentId, output.versionId, output.filename)}
        className="grid min-h-10 w-full grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-2 rounded-lg px-2 text-left text-sm outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600">
        <Download className="h-4 w-4 text-red-700" />
        <span className="font-medium text-gray-900">{role === "table" ? "Table"
          : role === "book" ? "Book"
            : output.filename.toLowerCase().endsWith(".pdf") ? "Filing PDF" : "Word copy"}</span>
        <span className="min-w-0 truncate text-gray-500">{output.filename}</span>
        <span className="text-[11px] uppercase text-gray-500">{output.filename.split(".").at(-1)}</span>
      </button>)}
    </div>
  </section>;
}

function BookContents({ draft, busy, onAction, sourceIssues, onRelink, onFiles, onPick }: {
  draft: AuthoritiesProduct; busy: boolean; onAction: (action: AuthoritiesAction) => void;
  sourceIssues: Record<string, AuthoritiesSourceIssue>; onRelink: (role: string) => void;
  onFiles?: (slot: "cover" | "index", files: File[]) => void;
  onPick?: (slot: "cover" | "index", multiple: boolean) => void;
}) {
  const add = (slot: "cover" | "index", multiple: boolean) => onPick
    ? onPick(slot, multiple) : undefined;
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
            {part?.filename ?? "Generated"}</span>
          <div className="col-span-2 flex items-center justify-end gap-1 sm:col-span-1">
            {part && relinkable(issue) ? <Button type="button" variant="ghost" className="h-8 px-2 text-xs text-red-800"
              disabled={busy} onClick={() => onRelink(part.bindingRole)}>{sourceAction(issue, "file")}</Button>
              : onPick ? <Button type="button" variant="ghost" className="h-8 px-2 text-xs"
              disabled={busy} onClick={() => add(slot, false)}>{part ? "Replace" : "Add file"}</Button>
              : onFiles && <FileInputButton multiple={false} disabled={busy}
                label={part ? "Replace" : "Add file"} accept=".pdf,application/pdf"
                onFiles={(files) => onFiles(slot, files)} compact />}
            {part && <MoreActionsMenu label={`${title} options`} items={[{ label: "Use generated",
              disabled: busy, onSelect: () => onAction({ type: "clear-book-part", slot }) }]} />}
          </div>
        </div>;
      })}
    </div>
  </div>;
}

function AddAuthorityModal({ open, busy, onClose, onAdd }: { open: boolean; busy: boolean;
  onClose: () => void; onAdd: (kind: AuthorityKind, citation: string, name: string | null) => void }) {
  const [citation, setCitation] = useState(""), [name, setName] = useState("");
  const [kind, setKind] = useState<AuthorityKind>("case");
  const submit = () => {
    if (!citation.trim()) return;
    onAdd(kind, citation.trim(), name.trim() || null); setCitation(""); setName(""); setKind("case");
  };
  return <Modal open={open} onClose={onClose} size="md" breadcrumbs={["Add authority"]}
    className="h-auto max-h-[calc(100dvh-2rem)]" cancelAction={{ label: "Cancel", onClick: onClose }}
    primaryAction={{ label: "Add", disabled: busy || !citation.trim(), onClick: submit }}>
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
    <div className={cn("grid gap-2", columns && "sm:grid-cols-2")}>
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
    type === "margin" && "border-r-[3px] border-r-red-700",
    type === "sidelined" && "border-r-[3px] border-r-gray-950",
  )}>
    {type === "paragraph" && <span className="absolute inset-x-1.5 top-2.5 h-4 bg-red-100" />}
    {(type === "margin" || type === "text") &&
      <span className="absolute left-2 top-[15px] h-1.5 w-5 bg-red-200" />}
    {[8, 17, 26].map((top, index) => <span key={top}
      className={cn("absolute left-2 h-0.5 bg-gray-500", index === 1 ? "w-9" : "w-7")}
      style={{ top }} />)}
  </span>;
}

function SelectField<T extends string>({ label, value, options, onChange, disabled, className }: {
  label: string; value: T; options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void; disabled?: boolean; className?: string;
}) {
  return <label className={cn("block min-w-0 text-sm font-medium text-gray-800", className)}>{label}
    <ModalSelect id={`authorities-${label.toLowerCase().replaceAll(" ", "-")}`}
      value={value} disabled={disabled} onChange={(next) => onChange(next as T)}
      placeholder={null} className="mt-1" options={options} />
  </label>;
}

function FileInputButton({ multiple, disabled, label, ariaLabel, accept, onFiles, variant = "primary", compact = false }: {
  multiple: boolean; disabled: boolean; label: string; accept: string;
  ariaLabel?: string;
  onFiles: (files: File[]) => void; variant?: "primary" | "outline"; compact?: boolean;
}) {
  return <label className={buttonClassName({
    variant: variant === "primary" ? "default" : "outline",
    size: compact ? "compact" : "default",
    className: cn("cursor-pointer focus-within:ring-3 focus-within:ring-ring/50",
      disabled && "pointer-events-none opacity-50"),
  })}><FilePlus2 className="h-4 w-4" /> {label}
    <input className="sr-only" type="file" aria-label={ariaLabel} multiple={multiple} accept={accept} disabled={disabled}
      onChange={(event) => { onFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
  </label>;
}

function Status({ busy, busyText, status, error }: { busy: boolean; busyText: string;
  status: string; error: boolean }) {
  const visible = busy || !!status;
  return <p className={cn("mb-1 flex min-h-6 items-center rounded-md px-2 text-sm",
    visible && "bg-white shadow-sm ring-1 ring-gray-200",
    error ? "text-red-800" : "text-gray-600")}
    role="status" aria-live="polite" aria-atomic="true" aria-busy={busy || undefined}>
    {visible && <span className="mr-2 grid size-4 shrink-0 place-items-center" aria-hidden="true">
      {busy && <Loader2 className="size-4 motion-safe:animate-spin" />}
    </span>}
    {busy ? status || busyText : status}
  </p>;
}

const SOURCE_OPTIONS: ReadonlyArray<CardOption<AuthoritiesBuildSettings["sourceMode"]>> = [
  { value: "automatic", label: "Automatic sources",
    detail: "Use available original PDFs and rebuild anything missing from source text." },
  { value: "manual-originals", label: "Add missing PDFs myself",
    detail: "Keep missing sources open for PDFs you attach." },
  { value: "render", label: "Rebuild all sources from text",
    detail: "Create consistent pages from the available source text." },
];
const PASSAGE_OPTIONS: ReadonlyArray<CardOption<AuthoritiesBuildSettings["passageMarking"]>> = [
  { value: "margin", label: "Right-margin marker and exact quote", preview: "margin",
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

function orderedOccurrences(draft?: AuthoritiesProduct) {
  if (!draft) return [];
  return draft.state.units.flatMap((unit) => unit.occurrenceIds
    .flatMap((id) => draft.state.occurrences[id] ? [draft.state.occurrences[id]] : []));
}
function discrepancyKey(draft?: AuthoritiesProduct) {
  if (!draft || draft.state.import.kind !== "document") return "";
  const { authorities, occurrences, units } = draft.state;
  return JSON.stringify([
    units.map(({ id, kind, ordinal, footnoteId, footnoteRefs, text, occurrenceIds }) =>
      [id, kind, ordinal, footnoteId, footnoteRefs, text, occurrenceIds]),
    Object.keys(occurrences).sort().map((id) => {
      const { unitId, authorityId, reviewed, pinpoints, citation } = occurrences[id];
      return [id, unitId, authorityId, reviewed, pinpoints, citation];
    }),
    Object.keys(authorities).sort().map((id) => {
      const { kind, citation, name, sourceIdentity } = authorities[id];
      return [id, kind, citation, name, sourceIdentity];
    }),
  ]);
}
function metadata({ state: _state, ...item }: AuthoritiesProduct) { return item; }
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
  const body = all.slice(0, index + 1).filter(({ unitId }) => !/^footnote:/u.test(unitId)).length;
  return `In-text citation ${body}`;
}
function authorityName(item: AuthorityIdentity) {
  return item.displayName || item.name || item.citation || "Untitled authority";
}
function authorityLabel(item: AuthorityIdentity) {
  const name = authorityName(item), citation = item.citation.trim();
  return !citation || name.toLocaleLowerCase().includes(citation.toLocaleLowerCase())
    ? name : `${name}, ${citation}`;
}
function authorityCitationForms(item: AuthorityIdentity, occurrences: AuthorityOccurrence[]) {
  return [...new Set([item.citation, ...occurrences.filter(({ authorityId, kind }) =>
    authorityId === item.id && kind !== "reference").map(({ citation }) => citation)]
    .map((citation) => citation.trim()).filter(Boolean))];
}
function automaticTab(index: number, style: AuthoritiesBuildSettings["tabStyle"]) {
  if (style === "numeric") return String(index);
  let label = "";
  for (let value = index; value > 0; value = Math.floor((value - 1) / 26))
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  return label;
}
function pdfCount(items: AuthorityIdentity[]) {
  return items.filter(({ source }) => source.kind === "attached").length;
}
function attachedRole(item: AuthorityIdentity) {
  return item.source.kind === "attached" ? item.source.bindingRole : null;
}
function requiresPdf(state: AuthoritiesProduct["state"], item: AuthorityIdentity) {
  return state.settings.sourceMode === "manual-originals" || state.outputMode !== "table" ||
    requiresUnlinkedTablePdf(state, item);
}
function missingSource(state: AuthoritiesProduct["state"], item: AuthorityIdentity) {
  if (!requiresPdf(state, item)) return false;
  return state.settings.sourceMode === "manual-originals" ||
    item.source.kind === "pending-canlii";
}
function mustAttachPdf(state: AuthoritiesProduct["state"], item: AuthorityIdentity) {
  if (state.outputMode === "table") return requiresUnlinkedTablePdf(state, item);
  return !!authoritiesProfile(state.settings.profileId).requirements?.completeBookSources;
}
function requiresUnlinkedTablePdf(state: AuthoritiesProduct["state"], item: AuthorityIdentity) {
  const sourceUrl = item.source.kind === "attached" ? item.source.sourceUrl
    : item.source.kind === "pending-canlii" ? item.source.pageUrl
      : item.sourceIdentity?.externalUrl;
  return !!authoritiesProfile(state.settings.profileId).requirements?.unlinkedPdfTableSources &&
    state.import.kind === "document" && state.import.fileType === "pdf" && !sourceUrl;
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
function sourceAction(issue: AuthoritiesSourceIssue, label: string) {
  return issue.status === "changed" ? `Use updated ${label}` : "Allow file access";
}
function relinkable(issue?: AuthoritiesSourceIssue | null): issue is AuthoritiesSourceIssue {
  return issue?.status === "changed" ||
    (issue?.status === "missing" && issue.reason === "permission");
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
      ? value as StartPreferences : DEFAULTS;
  } catch { return DEFAULTS; }
}
