import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BookOpenText, ChevronDown, ChevronRight, FolderKanban, FolderPlus, GripVertical,
  Maximize2, Minimize2, Pencil, Plus, StickyNote, Trash2, X } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { NewProjectModal } from "@/app/components/projects/NewProjectModal";
import { ProjectChoiceList } from "@/app/components/projects/ProjectChoiceList";
import { FileDirectory } from "@/app/components/shared/FileDirectory";
import { FolderBrowser } from "@/app/components/shared/FolderBrowser";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import type { Document, Folder } from "@/app/components/shared/types";
import { SearchBar } from "@/app/components/ui/search-bar";
import { ActionMenu } from "@/app/components/ui/action-menu";
import { actOnResearchFile, createResearchFile, directoryResource, getResearchFile,
  runResearchFileQuery } from "@/app/lib/beaverApi";
import { isResearchDocument, legalSourceViewerHref, researchLabelPath,
  type ResearchAction, type ResearchFile, type ResearchLabel, type ResearchQueryInput,
  type ResearchSource } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { BeaverApiError } from "@/app/lib/apiTransport";
import { ResearchLabelCircle } from "./ResearchLabelCircle";
import { ResearchLabelPicker } from "./ResearchLabelPicker";

type Kind = "labels" | "list" | "highlights" | "search";
const KINDS: Kind[] = ["labels", "list", "highlights", "search"];
const TITLES: Record<Kind, string> = { labels: "Labels", list: "List", highlights: "Highlights",
  search: "Search Saved sources" };
const DEFAULT_PANELS: Array<Kind | null> = [...KINDS], STORAGE = "beaver.research.panels.v1",
  RECIPE = "beaver.research.recipe.v1";
const SLOT_CLASS = ["@min-[28rem]:col-start-1 @min-[28rem]:row-start-1", "@min-[28rem]:col-start-2 @min-[28rem]:row-start-1",
  "@min-[28rem]:col-start-1 @min-[28rem]:row-start-2", "@min-[28rem]:col-start-2 @min-[28rem]:row-start-2"];
const UNSORTED = "__unsorted__", UNCLASSIFIED = "Unclassified", PAGE_SIZE = 50;
const LABEL_DRAG = "application/x-beaver-research-label";
type Scope = ResearchLabel["scope"];
type Rule = NonNullable<ResearchQueryInput["rules"]>[number];
const fileTitle = (file: ResearchFile | null) => file?.document.filename
  .replace(/\.research\.md$/iu, "") ?? "Workspace";
const readPanels = () => { try { const value = JSON.parse(localStorage.getItem(STORAGE) ?? "null");
  const set = new Set(value?.filter?.(Boolean)); return Array.isArray(value) && value.length === 4 &&
    value.every((kind) => kind === null || KINDS.includes(kind)) && set.size === value.filter(Boolean).length
    ? value as Array<Kind | null> : DEFAULT_PANELS; } catch { return DEFAULT_PANELS; } };
const queryText = (input: Record<string, unknown>) => Array.isArray(input.rules)
  ? input.rules.map((rule) => String((rule as { phrase?: unknown }).phrase ?? "")).filter(Boolean).join("; ")
  : String(input.pattern ?? input.query ?? "Search");
const queryRules = (input: Record<string, unknown>) => Array.isArray(input.rules) ? input.rules as Rule[] : [];
const readRecipe = () => { try { const value = JSON.parse(localStorage.getItem(RECIPE) ?? "null");
  const valid = Array.isArray(value?.rules) && value.rules.every((rule: Rule) => rule && typeof rule.phrase === "string" &&
    typeof rule.slot === "string" && ["before", "after"].includes(rule.direction) && ["sentence", "line", "paragraph", "chars"].includes(rule.unit));
  return valid && ["prompt", "first", "longer", "shorter", "append"].includes(value.conflict) ? value as { rules: Rule[]; conflict: NonNullable<ResearchQueryInput["conflict"]> }
    : { rules: [] as Rule[], conflict: "first" as const };
  } catch { return { rules: [] as Rule[], conflict: "first" as const }; } };
const sourceName = (source: ResearchSource) => source.reference.title || source.reference.citation || source.reference.id;
const expandSelection = (selected: Set<string> | null, children: Map<string | null, ResearchLabel[]>) => {
  if (selected === null) return null; const ids = new Set(selected);
  for (const id of ids) if (id !== UNSORTED) children.get(id)?.forEach(({ id: child }) => ids.add(child)); return ids;
};
const itemSelected = (ids: string[], selected: Set<string> | null) => selected === null ||
  selected.has(UNSORTED) && !ids.length || ids.some((id) => selected.has(id));

function ChoiceMenu({ label, value, options, onChange, className = "" }: { label: string; value: string;
  options: readonly { value: string; label: string }[]; onChange: (value: string) => void; className?: string;
}) { const selected = options.find((option) => option.value === value)?.label;
  return <ActionMenu label={label} className={`min-w-0 ${className}`} items={options.map((option) => ({
    label: option.label, checked: option.value === value, onSelect: () => onChange(option.value) }))}
    triggerClassName="h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-2 text-xs text-gray-800 hover:border-gray-500">
    <span className="truncate">{selected}</span><ChevronDown aria-hidden="true" className="size-3.5" />
  </ActionMenu>; }

function Panel({ kind, title = TITLES[kind], expanded, onClose, onExpand, onDragStart, actions, children }: {
  kind: Kind; title?: string; onClose: () => void; actions?: ReactNode; children: ReactNode;
  expanded?: boolean; onExpand?: () => void; onDragStart?: React.DragEventHandler<HTMLElement>;
}) {
  return <section className="flex h-full min-h-64 min-w-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-app-surface @min-[28rem]:min-h-0">
    <header draggable={!expanded} onDragStart={(event) => {
      if ((event.target as Element).closest("button,input,label,form,a")) event.preventDefault(); else onDragStart?.(event); }}
      title={expanded ? undefined : "Drag onto an adjacent panel to expand"}
      className="flex min-h-9 cursor-grab items-center gap-1 border-b border-gray-200 bg-app-surface px-2 active:cursor-grabbing">
      <GripVertical aria-hidden="true" className="size-3.5 shrink-0 text-gray-300" />
      <h2 className="min-w-0 flex-1 text-sm font-semibold leading-tight text-gray-900">{title}</h2>
      <span onPointerDown={(event) => event.stopPropagation()}>{actions}</span>
      {onExpand && <button type="button" onClick={onExpand} aria-label={`${expanded ? "Restore" : "Expand"} ${title} panel`}
        onPointerDown={(event) => event.stopPropagation()}
        className="grid size-7 place-items-center rounded text-gray-500 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2">
        {expanded ? <Minimize2 aria-hidden="true" className="size-3.5" /> : <Maximize2 aria-hidden="true" className="size-3.5" />}
      </button>}
      <button type="button" onClick={onClose} aria-label={`Close ${title} panel`}
        onPointerDown={(event) => event.stopPropagation()}
        className="grid size-7 place-items-center rounded text-gray-500 hover:bg-gray-200 focus-visible:outline focus-visible:outline-2">
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto p-2">{children}</div>
  </section>;
}

export function ResearchFileBar({ file, projectId, onChange, rail, active = false }: {
  file: ResearchFile | null; projectId?: string; onChange: (file: ResearchFile) => void; rail?: HTMLElement | null; active?: boolean;
}) {
  const [panels, setPanels] = useState<Array<Kind | null>>(readPanels), [expanded, setExpanded] = useState<{ from: number; to: number } | null>(null);
  const [open, setOpen] = useState(false), [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
  const [createOpen, setCreateOpen] = useState(false), [renameOpen, setRenameOpen] = useState(false),
    [destination, setDestination] = useState<Folder | null>(null),
    [destinationProjectId, setDestinationProjectId] = useState<string | null>(projectId ?? null);
  const [folderOpen, setFolderOpen] = useState(false), [projectOpen, setProjectOpen] = useState(false),
    [directoryKey, setDirectoryKey] = useState(0), [folderError, setFolderError] = useState("");
  const [sourceSelected, setSourceSelected] = useState<Set<string> | null>(null),
    [highlightSelected, setHighlightSelected] = useState<Set<string> | null>(null), [highlightFilter, setHighlightFilter] = useState(false),
    [activeLabel, setActiveLabel] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set()), [labelSearch, setLabelSearch] = useState(""),
    [labelDrop, setLabelDrop] = useState<string | null>(null), [panelDrag, setPanelDrag] = useState<number | null>(null),
    [panelDrop, setPanelDrop] = useState<number | null>(null), [openedSources, setOpenedSources] = useState<Set<string>>(() => new Set());
  const [listSearch, setListSearch] = useState("");
  const [sort, setSort] = useState("saved"), [kindFilter, setKindFilter] = useState<Set<string>>(() => new Set()),
    [yearFilter, setYearFilter] = useState<Set<string>>(() => new Set()), [collectionFilter, setCollectionFilter] = useState<Set<string>>(() => new Set()),
    [page, setPage] = useState(0), [recipe, setRecipe] = useState(readRecipe);
  const [plain, setPlain] = useState(""), [syntax, setSyntax] = useState<"literal" | "terms">("literal"),
    [target, setTarget] = useState<"sources" | "passages">("sources"), [historySearch, setHistorySearch] = useState("");
  const [ruleEditor, setRuleEditor] = useState<{ index: number; rule: Rule } | null>(null);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const directory = useMemo(() => directoryResource(projectId ? { projectId } : { library: "files" }), [projectId]);
  const destinationDirectory = useMemo(() => directoryResource(destinationProjectId
    ? { projectId: destinationProjectId } : { library: "files" }), [destinationProjectId]);
  const labels = useMemo(() => file?.state.labels ?? {}, [file?.state.labels]);
  const allSources = useMemo(() => Object.values(file?.state.sources ?? {}), [file?.state.sources]);
  const allEvidence = useMemo(() => Object.values(file?.state.evidence ?? {}), [file?.state.evidence]);
  const queries = useMemo(() => Object.values(file?.state.queries ?? {}).reverse(), [file?.state.queries]);
  const children = useMemo(() => { const map = new Map<string | null, ResearchLabel[]>();
    Object.values(labels).forEach((label) => { const values = map.get(label.parentId) ?? [];
      values.push(label); values.sort((a, b) => a.order - b.order); map.set(label.parentId, values); }); return map; }, [labels]);
  const sourceLabelIds = useMemo(() => expandSelection(sourceSelected, children), [sourceSelected, children]);
  const highlightLabelIds = useMemo(() => expandSelection(highlightSelected, children), [highlightSelected, children]);
  const appliedHighlightIds = highlightFilter ? highlightLabelIds : null;
  const filterName = (selected: Set<string> | null) => { if (selected === null) return "";
    if (selected.size !== 1) return "filtered"; const id = [...selected][0]; return id === UNSORTED ? "Unsorted" : labels[id]?.name ?? id; };
  const listTitle = [filterName(sourceSelected), highlightFilter ? filterName(highlightSelected) : ""].filter(Boolean).join(" + ");
  const evidenceBySource = useMemo(() => { const map = new Map<string, typeof allEvidence>();
    allEvidence.forEach((item) => { const values = map.get(item.sourceId) ?? []; values.push(item); map.set(item.sourceId, values); });
    return map; }, [allEvidence]);
  const scopedSources = useMemo(() => allSources.filter((source) => itemSelected(source.labelIds, sourceLabelIds) &&
    (appliedHighlightIds === null || (evidenceBySource.get(source.id) ?? []).some((item) => itemSelected(item.labelIds, appliedHighlightIds)))),
    [allSources, sourceLabelIds, appliedHighlightIds, evidenceBySource]);
  const years = useMemo(() => [...new Set(allSources.map(({ reference }) => reference.date?.slice(0, 4))
    .filter((value): value is string => !!value))].sort().reverse(), [allSources]);
  const list = useMemo(() => scopedSources.filter((source) => { const haystack = [source.reference.title, source.reference.citation,
    source.reference.collection, source.note].join(" ").toLowerCase(); return haystack.includes(listSearch.toLowerCase()) &&
      (!kindFilter.size || kindFilter.has(source.reference.kind)) && (!yearFilter.size || yearFilter.has(source.reference.date?.slice(0, 4) ?? "")) &&
      (!collectionFilter.size || collectionFilter.has(source.reference.collection ?? "")); })
    .sort((a, b) => sort === "az" ? sourceName(a).localeCompare(sourceName(b)) : sort === "date"
      ? String(b.reference.date ?? "").localeCompare(String(a.reference.date ?? "")) : 0),
    [scopedSources, listSearch, kindFilter, yearFilter, collectionFilter, sort]);
  const labelCounts = useMemo(() => { const counts: Record<string, number> = {};
    const visit = (items: typeof allSources | typeof allEvidence, scope: Scope) => items.forEach(({ labelIds }) => {
      const applied = new Set<string>(); labelIds.forEach((id) => researchLabelPath(labels, id).forEach((label) => {
        if (label.scope === scope) applied.add(label.id); })); applied.forEach((id) => { counts[id] = (counts[id] ?? 0) + 1; }); });
    visit(allSources, "source"); visit(allEvidence, "highlight"); return counts;
  }, [labels, allSources, allEvidence]);
  useEffect(() => { localStorage.setItem(STORAGE, JSON.stringify(panels)); }, [panels]);
  useEffect(() => { localStorage.setItem(RECIPE, JSON.stringify(recipe)); }, [recipe]);
  useEffect(() => { if (active && !file) { setDestination(null); setDestinationProjectId(projectId ?? null); setCreateOpen(true); } }, [active, file, projectId]);
  useEffect(() => { if (open) setSelectedDocuments(file ? [file.document] : []); }, [open, file]);
  useEffect(() => setPage(0), [listSearch, kindFilter, yearFilter, collectionFilter, sourceSelected, highlightSelected]);

  async function act(action: ResearchAction, optimisticState?: ResearchFile["state"]) {
    if (!file) return null; setBusy(true); setStatus("");
    try { const next = await actOnResearchFile(file.document.id, file.versionId, action);
      onChange(optimisticState ? { ...next, state: optimisticState } : next); return next; }
    catch (reason) { if (reason instanceof BeaverApiError && reason.status === 409) try {
      const latest = await getResearchFile(file.document.id), next = await actOnResearchFile(file.document.id, latest.versionId, action);
      onChange(optimisticState ? { ...next, state: optimisticState } : next); return next;
    } catch (retry) { setStatus(errorMessage(retry, "Could not update research")); return null; }
      setStatus(errorMessage(reason, "Could not update research")); return null; }
    finally { setBusy(false); }
  }
  async function refresh(reason: unknown) {
    if (!(reason instanceof BeaverApiError) || reason.status !== 409 || !file) return false;
    try { onChange(await getResearchFile(file.document.id)); }
    catch { setStatus("Could not refresh research"); }
    return true;
  }
  async function choose(task: () => Promise<ResearchFile>) {
    setBusy(true); setStatus("");
    try { onChange(await task()); setOpen(false); }
    catch (reason) { setStatus(errorMessage(reason, "Could not open research")); }
    finally { setBusy(false); }
  }
  function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const value = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    if (value) void choose(async () => { const next = await createResearchFile({ title: value,
      projectId: destinationProjectId ?? undefined, folderId: destination?.id });
      setCreateOpen(false); return next; });
  }
  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!file) return; const title = String(new FormData(event.currentTarget).get("title") ?? "").trim();
    if (!title) return; setBusy(true); setStatus("");
    try { await directory.renameDocument(file.document.id, `${title.replace(/\.research\.md$/iu, "")}.research.md`);
      onChange(await getResearchFile(file.document.id)); setRenameOpen(false); }
    catch (reason) { setStatus(errorMessage(reason, "Could not rename workspace")); }
    finally { setBusy(false); }
  }
  async function createLibraryFolder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (!name) return; setBusy(true); setFolderError("");
    try { await directory.createFolder(name, destination?.id);
      setDirectoryKey((value) => value + 1); setFolderOpen(false); }
    catch (reason) { setFolderError(errorMessage(reason, "Could not create folder")); }
    finally { setBusy(false); }
  }
  async function addLabel(scope: Scope) {
    setBusy(true); setStatus("");
    try { const destination = file ?? await createResearchFile({ title: "Untitled workspace", projectId }), id = crypto.randomUUID();
      const selected = scope === "source" ? sourceSelected : highlightSelected, selectedId = selected?.size === 1 ? [...selected][0] : "";
      const parentId = labels[selectedId]?.scope === scope && researchLabelPath(labels, selectedId).length < 3 ? selectedId : null;
      const next = await actOnResearchFile(destination.document.id, destination.versionId,
        { type: "label", id, name: scope === "source" ? "New label" : "New category", parentId, scope,
          color: scope === "source" ? "#3498db" : "#eab308" });
      onChange(next); setActiveLabel(id); }
    catch (reason) { if (!await refresh(reason)) setStatus(errorMessage(reason, "Could not add label")); }
    finally { setBusy(false); }
  }
  async function editLabel(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault(); const label = labels[id], data = new FormData(event.currentTarget), name = String(data.get("name") ?? "").trim();
    if (label && name && await act({ type: "label", ...label, name,
      color: String(data.get("color") ?? label.color ?? "#1d4ed8") })) setActiveLabel(null);
  }
  async function reparent(id: string, parentId: string | null, order?: number) {
    const label = labels[id]; if (!label || id === parentId || parentId &&
      (labels[parentId]?.scope !== label.scope || researchLabelPath(labels, parentId).some((item) => item.id === id) ||
        researchLabelPath(labels, parentId).length >= 3)) return;
    await act({ type: "label", ...label, parentId, order: order ?? label.order });
  }
  async function query(input: Omit<ResearchQueryInput, "sourceIds" | "labelIds">) {
    if (!file) return; const filtered = sourceSelected !== null || highlightSelected !== null;
    if (filtered && !scopedSources.length) return setStatus("No sources selected");
    setBusy(true); setStatus("");
    try { const labelIds = sourceSelected === null ? [] : [...sourceSelected].filter((id) => id !== UNSORTED),
      request = { ...input, labelIds, ...(filtered ? { sourceIds: scopedSources.map(({ id }) => id) } : {}) };
      let current = file;
      for (let attempt = 0; attempt < 2; attempt++) try {
        const result = await runResearchFileQuery(current.document.id, { versionId: current.versionId, ...request });
        onChange(result.file); setStatus(`${result.counts.matches} matches`); return;
      } catch (reason) {
        if (!(reason instanceof BeaverApiError) || reason.status !== 409 || attempt) throw reason;
        current = await getResearchFile(current.document.id); onChange(current);
      } }
    catch (reason) { setStatus(errorMessage(reason, "Search failed")); }
    finally { setBusy(false); }
  }
  function runQuery() {
    const rules = recipe.rules.filter(({ phrase, slot }) => phrase.trim() && slot.trim())
      .map((rule) => ({ ...rule, phrase: rule.phrase.trim(), slot: labels[rule.slot]?.scope === "highlight" ? rule.slot : "Unclassified" }));
    if (rules.length) void query({ syntax: "literal", target: "sources", rules, conflict: recipe.conflict });
    else setStatus("Add a capture rule first");
  }
  function runPlain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (plain.trim()) void query({ text: plain.trim(), syntax, target });
  }
  function sourceHref(source: ResearchSource) { return legalSourceViewerHref(source.reference,
    file ? { fileId: file.document.id, sourceId: source.id } : undefined); }
  function saveRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ruleEditor) return;
    const rule = ruleEditor.rule, index = ruleEditor.index;
    if (!rule.phrase.trim() || !rule.slot) return;
    setRecipe((current) => ({ ...current, rules: index < 0 ? [...current.rules, rule]
      : current.rules.map((value, item) => item === index ? rule : value) }));
    setRuleEditor(null);
  }
  const ruleText = (rule: Rule) => `${rule.phrase} → ${rule.direction} ${rule.unit}${rule.unit === "chars" ? ` (${rule.chars ?? 100})` : ""} → ${labels[rule.slot]?.name ?? rule.slot}`;
  function matchesLabel(id: string, search: string): boolean { return !search || labels[id].name.toLowerCase().includes(search.toLowerCase()) ||
    (children.get(id) ?? []).some(({ id: child }) => matchesLabel(child, search)); }
  const countLabel = (id: string) => labelCounts[id] ?? 0;
  const filterItems = (values: string[], selected: Set<string>, change: (value: Set<string>) => void) =>
    values.map((value) => ({ label: value, checked: selected.has(value), keepOpen: true,
      onSelect: () => { const next = new Set(selected); if (next.has(value)) next.delete(value); else next.add(value); change(next); } }));
  function labelTree(scope: Scope, parentId: string | null, depth = 0): ReactNode {
    const search = scope === "source" ? labelSearch : "", selection = scope === "source" ? sourceSelected : highlightSelected;
    return (children.get(parentId) ?? []).filter((label) => label.scope === scope && matchesLabel(label.id, search)).map((label) => {
      const hasChildren = !!children.get(label.id)?.length, open = !collapsed.has(label.id) || !!search, count = countLabel(label.id);
      return <div key={label.id}>
        <div data-tree-drop-folder={label.id} draggable onDragStart={(event) => {
          if ((event.target as Element).closest("button,input,label,form,a")) { event.preventDefault(); return; }
          event.dataTransfer.setData(LABEL_DRAG, label.id); event.dataTransfer.effectAllowed = "move"; }}
          title="Drag to reorder or move into another label" onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(LABEL_DRAG) && !event.dataTransfer.types.includes("application/x-beaver-research-source")) return;
            event.preventDefault(); setLabelDrop(label.id); }} onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setLabelDrop(null); }} onDrop={(event) => { event.preventDefault(); setLabelDrop(null);
            const sourceId = event.dataTransfer.getData("application/x-beaver-research-source"), source = file?.state.sources[sourceId];
            if (scope === "source" && source) { void act({ type: "annotate", kind: "source", id: sourceId,
              labelIds: [label.id, ...source.labelIds.filter((id) => id !== label.id)] }); return; }
            const box = event.currentTarget.getBoundingClientRect(), nest = event.clientX - box.left > box.width * .6;
            void reparent(event.dataTransfer.getData(LABEL_DRAG), nest ? label.id : label.parentId,
              nest ? children.get(label.id)?.length ?? 0 : label.order + (event.clientY < box.top + box.height / 2 ? -.5 : .5)); }}
          className={`group flex h-9 w-full min-w-0 items-center gap-1.5 rounded-md pe-1 ${labelDrop === label.id
            ? "bg-red-50 ring-1 ring-inset ring-red-200" : selection?.has(label.id) ? "bg-gray-100" : "hover:bg-gray-50"}`}
          style={{ paddingInlineStart: 8 + depth * 16 }}>
          <GripVertical aria-hidden="true" className="size-3 shrink-0 cursor-grab text-gray-300 group-hover:text-gray-500" />
          <button type="button" disabled={!hasChildren} aria-label={`${open ? "Collapse" : "Expand"} ${label.name}`}
            onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(label.id)) next.delete(label.id); else next.add(label.id); return next; })}
            className="grid size-6 shrink-0 place-items-center rounded disabled:invisible">
            {open ? <ChevronDown aria-hidden="true" className="size-3.5" /> : <ChevronRight aria-hidden="true" className="size-3.5" />}
          </button>
          <label title={`Change ${label.name} colour`} className="relative grid size-6 shrink-0 cursor-pointer place-items-center rounded focus-within:outline focus-within:outline-2 focus-within:outline-offset-1">
            <FolderSvgIcon open={open} className="size-4" fill="currentColor" style={{ color: label.color ?? "#3498db" }} />
            <input type="color" value={label.color ?? "#3498db"} aria-label={`${label.name} color`}
              onClick={(event) => event.stopPropagation()} onChange={(event) => { const color = event.target.value;
                if (!file) return; const state = { ...file.state, labels: { ...labels, [label.id]: { ...label, color } } };
                onChange({ ...file, state }); void act({ type: "label", ...label, color }, state); }}
              className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
          {activeLabel === label.id ? <form onSubmit={(event) => void editLabel(event, label.id)} className="flex min-w-0 flex-1 items-center gap-1">
            <input required autoFocus name="name" aria-label="Label name" defaultValue={label.name}
              className="h-7 min-w-0 flex-1 rounded border border-gray-300 px-1.5 text-xs" />
            <button disabled={busy} className="h-7 rounded border px-1.5 text-xs">Done</button>
          </form> : <><button type="button" onClick={(event) => { const set = scope === "source" ? setSourceSelected : setHighlightSelected;
            set((current) => { if (!event.shiftKey) return new Set([label.id]); const next = new Set(current ?? []);
              if (next.has(label.id)) next.delete(label.id); else next.add(label.id); return next; }); }}
            aria-label={`${label.name}, ${count} ${scope === "source" ? "sources" : "passages"}`} className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-xs">
            <span className="min-w-0 flex-1 truncate">{label.name}</span><span className="tabular-nums text-gray-400">{count}</span>
          </button><button type="button" onClick={() => setActiveLabel(label.id)} aria-label={`Edit ${label.name}`}
            className="grid size-7 shrink-0 place-items-center rounded text-gray-500 opacity-0 hover:bg-gray-100 focus-visible:opacity-100 group-hover:opacity-100"><Pencil className="size-3" aria-hidden="true" /></button></>}
        </div>{hasChildren && open && labelTree(scope, label.id, depth + 1)}
      </div>;
    });
  }

  function labelPanel(scope: Scope) { const selection = scope === "source" ? sourceSelected : highlightSelected,
    setSelection = scope === "source" ? setSourceSelected : setHighlightSelected;
    return <>{scope === "source" && <div className="mb-1 flex items-center gap-1">
      <button type="button" onClick={() => setSelection(null)} className={`rounded px-2 py-1 text-xs font-semibold ${selection === null ? "bg-gray-200" : "hover:bg-gray-100"}`}>View all</button>
      <button type="button" onClick={() => setSelection(new Set())} className={`rounded px-2 py-1 text-xs font-semibold text-gray-500 ${selection?.size === 0 ? "bg-gray-200" : "hover:bg-gray-100"}`}>View none</button>
      <input type="search" value={labelSearch} onChange={(event) => setLabelSearch(event.target.value)} aria-label="Search labels"
        placeholder="Search..." className="h-8 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-xs" />
    </div>}
    {scope === "highlight" && <label className="mb-1 flex items-center gap-1 rounded bg-gray-50 px-1.5 py-1 text-xs leading-4 text-gray-600">
      <input type="checkbox" checked={highlightFilter} onChange={(event) => setHighlightFilter(event.target.checked)} />
      Only show items with currently selected highlights
    </label>}
    <div>{labelTree(scope, null)}</div>
    {scope === "highlight" && allEvidence.some(({ labelIds }) => labelIds.includes(UNCLASSIFIED)) && <button type="button"
      onClick={() => setSelection(new Set([UNCLASSIFIED]))}
      className={`mt-1 flex min-h-8 w-full items-center gap-2 rounded px-2 text-left text-xs ${selection?.has(UNCLASSIFIED) ? "bg-gray-200" : "hover:bg-gray-50"}`}>
      <ResearchLabelCircle labels={labels} labelIds={[]} size="sm" />Unclassified
      <span className="ms-auto tabular-nums text-gray-400">{allEvidence.filter(({ labelIds }) => labelIds.includes(UNCLASSIFIED)).length}</span>
    </button>}
    {scope === "source" && <button type="button" onClick={() => setSelection(new Set([UNSORTED]))}
      className={`mt-1 flex min-h-8 w-full items-center gap-2 rounded border px-2 text-left text-xs font-semibold text-gray-400 ${selection?.has(UNSORTED) ? "bg-gray-200" : "hover:bg-gray-50"}`}>
      <ResearchLabelCircle labels={labels} labelIds={[]} size="sm" />Unsorted
    </button>}
    <button type="button" disabled={busy} onClick={() => void addLabel(scope)} onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); setLabelDrop(null); const id = event.dataTransfer.getData(LABEL_DRAG);
        if (labels[id]?.scope === scope) void reparent(id, null, children.get(null)?.filter((label) => label.scope === scope).length ?? 0); }}
      className="mt-1 flex min-h-8 w-full items-center rounded border border-dashed border-gray-300 px-2 text-left text-xs text-gray-400 hover:border-gray-500 hover:text-gray-700">
      + Add {scope === "source" ? "label" : "category"}
    </button></>; }
  const labelsPanel = labelPanel("source"), highlightsPanel = labelPanel("highlight");
  const listPanel = <>
    <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-1.5 text-xs text-gray-600"><span>Sort</span>
      <ChoiceMenu label="Sort sources" value={sort} onChange={setSort} options={[
        { value: "saved", label: "Saved order" }, { value: "az", label: "A–Z" }, { value: "date", label: "Date" }]} />
      <input type="search" value={listSearch} onChange={(event) => setListSearch(event.target.value)} aria-label="Search list"
        placeholder="Search sources" className="col-span-2 h-8 min-w-0 rounded-md border border-gray-300 px-2 text-xs" />
    </div>
    <div className="mt-1.5 grid grid-cols-3 gap-1 text-xs text-gray-600">
      <ActionMenu label="Filter source type" items={filterItems([...new Set(allSources.map(({ reference }) => reference.kind))], kindFilter, setKindFilter)}
        triggerClassName={`h-8 w-full items-center justify-between gap-1 rounded-md border border-gray-300 bg-white px-2 text-xs ${kindFilter.size ? "font-semibold text-gray-900" : ""}`}>Type{kindFilter.size ? ` (${kindFilter.size})` : ""}<ChevronDown className="size-3" /></ActionMenu>
      <ActionMenu label="Filter jurisdiction" items={filterItems([...new Set(allSources.map(({ reference }) => reference.collection).filter((value): value is string => typeof value === "string"))], collectionFilter, setCollectionFilter)}
        triggerClassName={`h-8 w-full items-center justify-between gap-1 rounded-md border border-gray-300 bg-white px-2 text-xs ${collectionFilter.size ? "font-semibold text-gray-900" : ""}`}>Jurisdiction{collectionFilter.size ? ` (${collectionFilter.size})` : ""}<ChevronDown className="size-3" /></ActionMenu>
      <ActionMenu label="Filter year" items={filterItems(years, yearFilter, setYearFilter)}
        triggerClassName={`h-8 w-full items-center justify-between gap-1 rounded-md border border-gray-300 bg-white px-2 text-xs ${yearFilter.size ? "font-semibold text-gray-900" : ""}`}>Year{yearFilter.size ? ` (${yearFilter.size})` : ""}<ChevronDown className="size-3" /></ActionMenu>
    </div>
    <div className="mt-1 min-h-0 rounded-md border border-gray-200 p-1">
    <div className="mb-1 flex items-center text-xs"><span role="status" className="tabular-nums text-gray-500">{list.length} sources</span></div>
    {list.length ? <ol>{list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((source) => {
      const evidence = (evidenceBySource.get(source.id) ?? []).filter((item) => itemSelected(item.labelIds, appliedHighlightIds));
      return <li key={source.id}><details className="group rounded hover:bg-gray-50" onToggle={(event) => {
        const isOpen = event.currentTarget.open; setOpenedSources((current) => { const next = new Set(current);
          if (isOpen) next.add(source.id); else next.delete(source.id); return next; }); }}><summary className="flex cursor-pointer list-none items-center gap-1 px-1 py-1 text-xs">
        <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-gray-400 transition-transform group-open:rotate-90" />
        <ResearchLabelPicker file={file} kind="source" itemId={source.id} labelIds={source.labelIds}
          badge={source.badge} badgeColor={source.badgeColor} note={source.note} title={sourceName(source)} size="sm" onChange={onChange} />
        <span className="min-w-0 flex-1 truncate font-medium">{sourceName(source)}</span>
        {source.note && <StickyNote aria-label="Has note" className="size-3 shrink-0 text-gray-400" />}
      </summary>{openedSources.has(source.id) && <div className="space-y-1 px-6 pb-2 text-xs leading-4">
        <div className="flex items-center justify-between text-gray-500"><span>{evidence.length} passages</span>
          <a href={sourceHref(source)} className="rounded px-1.5 py-0.5 hover:bg-gray-200 hover:text-gray-900">Open source</a></div>
        {!!source.labelIds.length && <p className="text-gray-500">{source.labelIds.map((id) => researchLabelPath(labels, id).map(({ name }) => name).join(" / ")).join(", ")}</p>}
        {source.note && <p className="whitespace-pre-wrap text-gray-600">{source.note}</p>}
        {evidence.map((item) => <div key={item.receipt.evidence_id} className="border-s-2 border-gray-200 ps-2">
          <div className="flex items-center gap-1"><ResearchLabelPicker file={file} kind="evidence" itemId={item.receipt.evidence_id}
            labelIds={item.labelIds} note={item.note} title={item.receipt.locator.label} size="sm" onChange={onChange} />
            <a href={`${sourceHref(source)}&locator=${encodeURIComponent(item.receipt.locator.label)}`} className="font-medium underline">{item.receipt.locator.label}</a>
            <button type="button" aria-label={`Delete ${item.receipt.locator.label}`} onClick={() => void act({ type: "remove", kind: "evidence", id: item.receipt.evidence_id })}
              className="ms-auto grid size-6 place-items-center rounded text-gray-400 hover:bg-gray-200 hover:text-red-700"><Trash2 className="size-3" /></button></div>
          <p className="line-clamp-3 text-gray-600">{item.receipt.span_text}</p>{item.note && <p className="mt-0.5 text-gray-700">{item.note}</p>}
        </div>)}
        <button type="button" onClick={() => void act({ type: "remove", kind: "source", id: source.id })}
          className="text-xs text-gray-400 hover:text-red-700">Remove source</button>
      </div>}</details></li>;
    })}</ol> : <p className="p-2 text-xs text-gray-500">No sources in this view.</p>}
    {list.length > PAGE_SIZE && <div className="mt-2 flex items-center justify-center gap-2 text-xs"><button type="button" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button>
      <span>Page {page + 1} of {Math.ceil(list.length / PAGE_SIZE)}</span><button type="button" disabled={(page + 1) * PAGE_SIZE >= list.length} onClick={() => setPage(page + 1)}>Next</button></div>}
    </div></>;
  const shownQueries = useMemo(() => queries.filter((item) => JSON.stringify(item).toLowerCase()
    .includes(historySearch.toLowerCase())), [queries, historySearch]);
  const searchPanel = file ? <>
    <form onSubmit={runPlain} className="mb-2 grid grid-cols-2 gap-1.5 border-b border-gray-200 pb-2">
      <input required value={plain} onChange={(event) => setPlain(event.target.value)} aria-label="Search saved source text"
        placeholder="Find in saved text" className="col-span-2 h-8 min-w-0 rounded-md border border-gray-300 px-2 text-xs" />
      <ChoiceMenu label="Search syntax" value={syntax} onChange={(value) => setSyntax(value as typeof syntax)}
        options={[{ value: "literal", label: "Exact" }, { value: "terms", label: "All terms" }]} />
      <ChoiceMenu label="Search target" value={target} onChange={(value) => setTarget(value as typeof target)}
        options={[{ value: "sources", label: "Source text" }, { value: "passages", label: "Saved passages" }]} />
      <button disabled={busy} className="col-span-2 h-8 rounded-md bg-gray-900 px-2 text-xs font-medium text-white hover:bg-gray-700 disabled:opacity-40">Find passages</button>
    </form>
    <p className="text-xs leading-4 text-gray-500">Rules capture text around phrases across the saved sources in this view.</p>
    <div className="mb-2 mt-1.5 flex gap-1.5">
      <button type="button" onClick={() => setRuleEditor({ index: -1,
        rule: { phrase: "", direction: "after", unit: "sentence", slot: "Unclassified" } })}
        className="inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-md border border-gray-300 bg-white px-2 text-xs font-medium text-gray-700 hover:bg-gray-50"><Plus className="size-3.5" />Add rule</button>
      <button type="button" disabled={busy} onClick={runQuery}
        className="h-8 flex-1 rounded-md bg-brand px-2 text-xs font-medium text-white hover:bg-brand-dark disabled:opacity-40">Run rules</button>
    </div>
    <div className="space-y-1">{recipe.rules.map((rule, index) => <div key={index}
      className="flex min-h-8 items-center gap-1 rounded bg-gray-50 px-1.5 text-xs">
      <button type="button" onClick={() => setRuleEditor({ index, rule: { ...rule } })}
        className="min-w-0 flex-1 truncate text-left hover:underline">{ruleText(rule)}</button>
      <button type="button" onClick={() => setRecipe((current) => ({ ...current,
        rules: current.rules.filter((_, item) => item !== index) }))} aria-label={`Remove rule ${index + 1}`}
        className="grid size-6 place-items-center rounded text-gray-400 hover:bg-gray-200 hover:text-red-700"><X className="size-3" /></button>
    </div>)}</div>
    {!recipe.rules.length && <p className="rounded border border-dashed border-gray-300 p-2 text-xs text-gray-500">No capture rules yet.</p>}
    <label className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs text-gray-600">When rules overlap
      <ChoiceMenu label="Conflict policy" value={recipe.conflict} onChange={(value) => setRecipe((current) => ({ ...current, conflict: value as typeof current.conflict }))}
        options={[{ value: "prompt", label: "Keep for review" }, { value: "first", label: "First rule wins" }, { value: "longer", label: "Longer passage" }, { value: "shorter", label: "Shorter passage" }, { value: "append", label: "Keep both" }]} />
    </label>
    {!!queries.length && <details className="group/history mt-2 overflow-hidden rounded-md border border-gray-200 text-xs text-gray-600">
      <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 bg-gray-50 px-2 font-medium text-gray-800">
        <ChevronRight className="size-3.5 transition-transform group-open/history:rotate-90" aria-hidden="true" />Search history
        <span className="ms-auto tabular-nums text-gray-500">{queries.length}</span>
      </summary><div className="space-y-1.5 border-t border-gray-200 p-2">
      <SearchBar value={historySearch} onValueChange={setHistorySearch} size="sm" placeholder="Search history" aria-label="Search history" />
      <ol className="space-y-1">{shownQueries.map((item) => { const saved = queryRules(item.input); return <li key={item.query_id}>
        <details className="group/query rounded-md border border-gray-200 bg-white"><summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5">
          <ChevronRight className="size-3 transition-transform group-open/query:rotate-90" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium text-gray-800">{queryText(item.input)}</span>
          <span className="shrink-0 tabular-nums text-gray-500">{item.evidenceIds.length} matches</span></summary>
          <div className="space-y-1 border-t border-gray-100 px-2 py-1.5 leading-4">
          <p>{saved.length ? saved.map(ruleText).join("; ") : `${String(item.input.syntax ?? "literal")} · ${String(item.input.target ?? "sources")}`}</p>
          <p className="text-gray-500">{item.executed_at} · {item.model || "human"} · {item.sourceIds.length} sources · {item.failures.length} failures</p>
          {!!Object.keys(item.slots).length && <p>Slots: {Object.values(item.slots).flat().map((id) => labels[id]?.name ?? id).join(", ")}</p>}
          {!!saved.length && <button type="button" onClick={() => setRecipe({ rules: saved.map((rule) => ({ ...rule })),
            conflict: ["prompt", "first", "longer", "shorter", "append"].includes(String(item.input.conflict))
              ? item.input.conflict as typeof recipe.conflict : "first" })} className="mt-1 rounded border px-2 py-1 font-medium text-gray-700 hover:bg-gray-50">Use these rules</button>}
          </div></details></li>; })}</ol></div></details>}
  </> : <p className="p-2 text-xs text-gray-500">Open or create a workspace to search saved sources.</p>;
  const content: Record<Kind, ReactNode> = { labels: labelsPanel, list: listPanel, highlights: highlightsPanel,
    search: searchPanel };
  const adjacent = (index: number) => [index % 2 ? index - 1 : index + 1, index < 2 ? index + 2 : index - 2]
    .filter((candidate) => candidate >= 0 && candidate < panels.length);
  const neighbor = (index: number) => adjacent(index)[0];
  const selectedSourceLabel = sourceSelected?.size === 1 ? [...sourceSelected][0] : null,
    selectedHighlight = highlightSelected?.size === 1 ? [...highlightSelected][0] : null;
  const panelActions: Partial<Record<Kind, ReactNode>> = {
    labels: <button type="button" disabled={busy || !selectedSourceLabel || !labels[selectedSourceLabel]}
        onClick={() => selectedSourceLabel && void act({ type: "remove", kind: "label", id: selectedSourceLabel })}
        aria-label="Delete selected label" className="grid size-7 place-items-center rounded text-gray-500 hover:bg-gray-200 disabled:opacity-30"><Trash2 className="size-3" /></button>,
    highlights: <button type="button" disabled={busy || !selectedHighlight || !labels[selectedHighlight]}
        onClick={() => selectedHighlight && void act({ type: "remove", kind: "label", id: selectedHighlight })}
        aria-label="Delete selected highlight category" className="grid size-7 place-items-center rounded text-gray-500 hover:bg-gray-200 disabled:opacity-30"><Trash2 className="size-3" /></button>,
  };

  const selector = <ActionMenu label="Workspace options" items={[
    ...(file ? [{ label: "Rename", onSelect: () => setRenameOpen(true) }] : []),
    { label: "Open another", onSelect: () => setOpen(true) },
    { label: "New workspace", onSelect: () => { setDestination(null); setDestinationProjectId(projectId ?? null); setCreateOpen(true); } },
  ]} triggerClassName="group inline-flex h-8 min-w-0 max-w-56 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2 text-left text-xs font-medium text-gray-800 shadow-sm hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
    <BookOpenText className="size-3.5 shrink-0 text-brand" aria-hidden="true" />
    <span className="min-w-0 flex-1 truncate">{file ? fileTitle(file) : "Open existing"}</span>
    <ChevronDown className="size-3.5 shrink-0 text-gray-400" aria-hidden="true" />
  </ActionMenu>;
  return <div className="@container relative flex h-full min-h-0 flex-col overflow-auto @min-[28rem]:overflow-hidden">
    {rail === undefined ? <div className="flex h-10 shrink-0 items-center pb-2">{selector}</div>
      : rail ? createPortal(selector, rail) : null}
    {status && <span role="status" className="pointer-events-none absolute bottom-2 left-1/2 z-30 max-w-[calc(100%-1rem)] -translate-x-1/2 truncate rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 shadow-lg">{status}</span>}
    <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 @min-[28rem]:grid-cols-2 @min-[28rem]:grid-rows-2" aria-label="Research panels">
      {panels.map((kind, index) => expanded?.to === index ? null : kind ? <div key={index}
        onDragEnd={() => { setPanelDrag(null); setPanelDrop(null); }}
        onDragOver={(event) => { if (panelDrag !== null && adjacent(panelDrag).includes(index)) { event.preventDefault(); setPanelDrop(index); } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setPanelDrop(null); }}
        onDrop={(event) => { event.preventDefault(); setPanelDrop(null);
          if (panelDrag !== null && adjacent(panelDrag).includes(index)) setExpanded({ from: panelDrag, to: index }); }}
        className={`min-h-0 rounded-lg ${panelDrop === index ? "ring-2 ring-inset ring-red-300" : ""} ${expanded?.from === index ? Math.abs(expanded.from - expanded.to) === 1
          ? `${index < 2 ? "@min-[28rem]:row-start-1" : "@min-[28rem]:row-start-2"} @min-[28rem]:col-start-1 @min-[28rem]:col-span-2`
          : `${index % 2 ? "@min-[28rem]:col-start-2" : "@min-[28rem]:col-start-1"} @min-[28rem]:row-start-1 @min-[28rem]:row-span-2`
          : SLOT_CLASS[index]}`}>
        <Panel kind={kind} title={kind === "list" && listTitle ? listTitle : undefined} actions={panelActions[kind]} expanded={expanded?.from === index}
          onClose={() => { setPanels((current) => current.map((value, item) => item === index ? null : value));
            setExpanded((current) => current && (current.from === index || current.to === index) ? null : current); }}
          onDragStart={(event) => { setPanelDrag(index); event.dataTransfer.effectAllowed = "move"; }}
          onExpand={expanded?.from === index ? () => setExpanded(null) : neighbor(index) === undefined ? undefined
            : () => setExpanded({ from: index, to: neighbor(index)! })}>{content[kind]}</Panel></div>
        : <section key={index} onDragOver={(event) => {
          if (panelDrag !== null && adjacent(panelDrag).includes(index)) { event.preventDefault(); setPanelDrop(index); } }}
          onDrop={(event) => { event.preventDefault(); setPanelDrop(null);
            if (panelDrag !== null && adjacent(panelDrag).includes(index)) setExpanded({ from: panelDrag, to: index }); }}
          className={`${SLOT_CLASS[index]} grid min-h-64 place-items-center rounded-lg bg-gray-50/60 @min-[28rem]:min-h-0 ${panelDrop === index ? "ring-2 ring-inset ring-red-300" : ""}`}>
          <ActionMenu label={`Add panel to slot ${index + 1}`} items={[
            ...KINDS.filter((value) => !panels.some((panel, slot) => panel === value && slot !== expanded?.to))
              .map((value) => ({ label: TITLES[value], onSelect: () => { setPanels((current) => current.map((panel, slot) =>
                slot === index ? value : slot === expanded?.to && panel === value ? null : panel)); setExpanded(null); } })),
            ...adjacent(index).flatMap((from) => panels[from] ? [{ label: `Expand ${TITLES[panels[from]!]}`,
              onSelect: () => setExpanded({ from, to: index }) }] : []),
          ]}
            triggerClassName="inline-flex h-8 items-center gap-1 rounded-md border border-gray-300 bg-white px-2 text-xs font-medium text-gray-600 hover:bg-gray-100"><Plus className="size-3.5" />Add panel</ActionMenu>
        </section>)}
    </div>
    <Modal open={!!ruleEditor} onClose={() => setRuleEditor(null)} size="sm" className="!h-fit max-h-[calc(100dvh-2rem)] [&_.modal-scroll-body]:flex-none"
      breadcrumbs={["Search Saved sources", ruleEditor?.index === -1 ? "New rule" : "Edit rule"]}
      cancelAction={{ label: "Cancel", onClick: () => setRuleEditor(null) }}
      primaryAction={{ label: "Save rule", type: "submit", form: "research-rule-form" }}>
      {ruleEditor && <form id="research-rule-form" onSubmit={saveRule} className="grid grid-cols-2 gap-3 pb-5 text-xs">
        <label className="col-span-2 grid gap-1 text-gray-600">Phrase to find
          <input required autoFocus value={ruleEditor.rule.phrase} onChange={(event) => setRuleEditor((value) => value && ({ ...value,
            rule: { ...value.rule, phrase: event.target.value } }))} className="h-9 rounded border border-gray-300 px-2 text-gray-900" />
        </label>
        <label className="grid gap-1 text-gray-600">Direction
          <ChoiceMenu label="Direction" value={ruleEditor.rule.direction} onChange={(direction) => setRuleEditor((value) => value && ({ ...value,
            rule: { ...value.rule, direction: direction as Rule["direction"] } }))}
            options={[{ value: "after", label: "After phrase" }, { value: "before", label: "Before phrase" }]} />
        </label>
        <label className="grid gap-1 text-gray-600">Unit
          <ChoiceMenu label="Unit" value={ruleEditor.rule.unit} onChange={(unit) => setRuleEditor((value) => value && ({ ...value,
            rule: { ...value.rule, unit: unit as Rule["unit"] } }))}
            options={[{ value: "sentence", label: "Sentence" }, { value: "line", label: "Line" }, { value: "paragraph", label: "Paragraph" }, { value: "chars", label: "Characters" }]} />
        </label>
        <label className="grid gap-1 text-gray-600">Save as highlight
          <ChoiceMenu label="Save as highlight" value={ruleEditor.rule.slot} onChange={(slot) => setRuleEditor((value) => value && ({ ...value,
            rule: { ...value.rule, slot } }))} options={[{ value: "Unclassified", label: "Unclassified" },
              ...Object.values(labels).filter(({ scope }) => scope === "highlight").sort((a, b) => a.order - b.order)
                .map((label) => ({ value: label.id, label: label.name }))]} />
        </label>
        {ruleEditor.rule.unit === "chars" && <label className="grid gap-1 text-gray-600">Characters
          <input type="number" min="10" max="50000" value={ruleEditor.rule.chars ?? 100} onChange={(event) => setRuleEditor((value) => value && ({ ...value,
            rule: { ...value.rule, chars: Number(event.target.value) } }))} className="h-9 rounded border px-2 text-gray-900" />
        </label>}
      </form>}
    </Modal>
    <Modal open={open} onClose={() => setOpen(false)} size="lg" breadcrumbs={["Library", "Workspaces"]}
      headerAction={<div className="flex items-center gap-1.5">
        <button type="button" onClick={() => { setDestination(null); setDestinationProjectId(projectId ?? null); setCreateOpen(true); }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-gray-900 px-2.5 text-xs font-medium text-white hover:bg-gray-700"><Plus className="size-3.5" />New workspace</button>
        <button type="button" onClick={() => { setDestination(null); setFolderError(""); setFolderOpen(true); }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-50"><FolderPlus className="size-3.5" />New folder</button>
        <button type="button" onClick={() => setProjectOpen(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-xs font-medium text-gray-700 hover:bg-gray-50"><FolderKanban className="size-3.5" />New project</button>
      </div>}
      cancelAction={{ label: "Close", onClick: () => setOpen(false) }} primaryAction={{ label: busy ? "Opening..." : "Open",
        onClick: () => { const document = selectedDocuments.find(isResearchDocument); if (document) void choose(() => getResearchFile(document.id)); },
        disabled: busy || !selectedDocuments.some(isResearchDocument) }}>
      <FileDirectory key={directoryKey} selectedDocuments={selectedDocuments} onChange={(items) => setSelectedDocuments(items.slice(-1))}
        showTabs={!projectId} projectId={projectId} initialTab={projectId ? "projects" : "files"}
        tabs={[["files", "Library"], ["projects", "Projects"]]} noun="workspaces" multiple={false} documentFilter={isResearchDocument} />
    </Modal>
    <Modal open={createOpen} onClose={() => setCreateOpen(false)} size="sm" breadcrumbs={["Workspaces", "New workspace"]}
      className="!h-[min(34rem,calc(100dvh-2rem))]" cancelAction={{ label: "Cancel", onClick: () => setCreateOpen(false) }}
      primaryAction={{ label: busy ? "Creating..." : "Create workspace", type: "submit", form: "research-create", disabled: busy }}>
      <form id="research-create" onSubmit={create} className="flex h-full min-h-0 flex-col gap-3 pb-4">
        <label className="grid gap-1 text-xs font-medium text-gray-700">Workspace name
          <input required autoFocus name="title" placeholder="e.g. Duty of care" className="h-9 rounded-md border border-gray-300 px-2 text-sm font-normal text-gray-900" />
        </label>
        {!projectId && <div className="flex gap-1">
          <button type="button" onClick={() => { setDestinationProjectId(null); setDestination(null); }}
            className={`h-8 flex-1 rounded-md text-xs font-medium ${destinationProjectId ? "bg-gray-100 text-gray-600" : "bg-gray-900 text-white"}`}>Library</button>
          <button type="button" onClick={() => { setDestinationProjectId(""); setDestination(null); }}
            className={`h-8 flex-1 rounded-md text-xs font-medium ${destinationProjectId === null ? "bg-gray-100 text-gray-600" : "bg-gray-900 text-white"}`}>Project</button>
        </div>}
        {destinationProjectId === "" ? <ProjectChoiceList value={null} onChange={(id) => { setDestinationProjectId(id); setDestination(null); }} />
          : <FolderBrowser key={destinationProjectId ?? "library"} list={destinationDirectory.list}
            rootLabel={destinationProjectId ? "Project" : "Library"} hideRoot onSelect={setDestination}
            onBack={!projectId && destinationProjectId ? () => { setDestinationProjectId(""); setDestination(null); } : undefined} />}
      </form>
    </Modal>
    <Modal open={renameOpen} onClose={() => setRenameOpen(false)} size="sm" className="!h-fit [&_.modal-scroll-body]:flex-none"
      breadcrumbs={["Workspace", "Rename"]} cancelAction={{ label: "Cancel", onClick: () => setRenameOpen(false) }}
      primaryAction={{ label: busy ? "Renaming..." : "Rename", type: "submit", form: "research-rename", disabled: busy }}>
      <form id="research-rename" onSubmit={rename} className="pb-5">
        <label className="grid gap-1 text-xs font-medium text-gray-700">Workspace name
          <input required autoFocus name="title" defaultValue={file ? fileTitle(file) : ""} className="h-9 rounded-md border border-gray-300 px-2 text-sm font-normal text-gray-900" />
        </label>
      </form>
    </Modal>
    <Modal open={folderOpen} onClose={() => setFolderOpen(false)} size="sm" className="!h-fit [&_.modal-scroll-body]:flex-none"
      breadcrumbs={["Library", "New folder"]} cancelAction={{ label: "Cancel", onClick: () => setFolderOpen(false) }}
      primaryAction={{ label: busy ? "Creating..." : "Create folder", type: "submit", form: "research-new-folder", disabled: busy }}>
      <form id="research-new-folder" onSubmit={createLibraryFolder} className="pb-5">
        <label className="grid gap-1 text-xs font-medium text-gray-600">Folder name
          <input required autoFocus name="name" className="h-9 rounded-md border border-gray-300 px-2 text-sm font-normal text-gray-900" />
        </label>
        {folderError && <p role="alert" className="mt-2 text-xs text-red-700">{folderError}</p>}
      </form>
    </Modal>
    <NewProjectModal open={projectOpen} onClose={() => setProjectOpen(false)} onCreated={() => {
      setDirectoryKey((value) => value + 1); setProjectOpen(false); }} />
  </div>;
}
