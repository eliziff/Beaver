import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { ChevronDown, ChevronRight, Ellipsis, FolderKanban, FolderPlus, GripVertical,
  Pencil, Plus, Search, Tags, Trash2, X } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { NewProjectModal } from "@/app/components/projects/NewProjectModal";
import { ProjectChoiceList } from "@/app/components/projects/ProjectChoiceList";
import { FileDirectory, type DirectoryLocation } from "@/app/components/shared/FileDirectory";
import { FolderBrowser } from "@/app/components/shared/FolderBrowser";
import { FolderSvgIcon } from "@/app/components/shared/FolderSvgIcon";
import type { Document, Folder } from "@/app/components/shared/types";
import { ActionMenu } from "@/app/components/ui/action-menu";
import { createResearchFile, directoryResource, getResearchFile, getResearchItems } from "@/app/lib/beaverApi";
import { usePagedChains } from "@/app/hooks/usePagedChains";
import { isResearchDocument, legalSourceViewerHref, researchLabelPath,
  type ResearchAction, type ResearchFile, type ResearchLabel, type ResearchQueryInput,
  type ResearchPageItem, type ResearchSource, type ResearchQueryCoverage } from "@/app/lib/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import { safeAssistantUrl } from "@/app/lib/safeAssistantUrl";
import { ResearchLabelCircle, researchLabelColor } from "./ResearchLabelCircle";
import { RESEARCH_SOURCE_DRAG, RESEARCH_SOURCE_REFERENCE_DRAG, ResearchLabelPicker } from "./ResearchLabelPicker";
import { useResearchFileMutations, type ResearchFileMutations } from "./useResearchFileMutations";

const RECIPE = "beaver.research.recipe.v1", COLLAPSED = "beaver.research.collapsed.v1";
const UNSORTED = "__unsorted__", UNCLASSIFIED = "Unclassified", PAGE_SIZE = 50;
const LABEL_DRAG = "application/x-beaver-research-label";
type Scope = ResearchLabel["scope"];
type Rule = NonNullable<ResearchQueryInput["rules"]>[number];
type LabelDrop = { id: string; mode: "before" | "inside" | "after" };
const fileTitle = (file: ResearchFile | null) => file?.document.filename
  .replace(/\.research\.md$/iu, "") ?? "Workspace";
const readCollapsed = (id?: string) => { try { const value = id
  ? JSON.parse(localStorage.getItem(`${COLLAPSED}:${id}`) ?? "null") : null;
  return new Set<string>(Array.isArray(value) ? value.filter((item) => typeof item === "string") : []);
  } catch { return new Set<string>(); } };
const queryText = (input: Record<string, unknown>) => Array.isArray(input.rules)
  ? input.rules.map((rule) => String((rule as { phrase?: unknown }).phrase ?? "")).filter(Boolean).join("; ")
  : String(input.pattern ?? input.query ?? "Search");
const queryRules = (input: Record<string, unknown>) => Array.isArray(input.rules) ? input.rules as Rule[] : [];
const queryConflict = (input: Record<string, unknown>): NonNullable<ResearchQueryInput["conflict"]> =>
  ["prompt", "first", "longer", "shorter", "append"].includes(String(input.conflict))
    ? input.conflict as NonNullable<ResearchQueryInput["conflict"]> : "first";
const receiptLabel = (labels: Record<string, ResearchLabel>, id: string,
  paths: Record<string, string> = {}) => paths[id] ??
  (researchLabelPath(labels, id).map(({ name }) => name).join(" / ") || id);
const slotSummary = (slots: Record<string, string[]>, labels: Record<string, ResearchLabel>,
  paths: Record<string, string> = {}) => {
  const counts = new Map<string, number>();
  Object.values(slots).forEach((ids) => ids.forEach((id) => { const name = receiptLabel(labels, id, paths);
    counts.set(name, (counts.get(name) ?? 0) + 1); }));
  return [...counts].map(([name, count]) => `${name}${count > 1 ? ` × ${count}` : ""}`).join(", ");
};
const readRecipe = (id?: string) => { try { const value = JSON.parse(localStorage.getItem(`${RECIPE}:${id ?? "empty"}`) ?? "null");
  const valid = Array.isArray(value?.rules) && value.rules.every((rule: Rule) => rule && typeof rule.phrase === "string" &&
    typeof rule.slot === "string" && ["before", "after"].includes(rule.direction) && ["sentence", "line", "paragraph", "chars"].includes(rule.unit));
  return valid ? { rules: value.rules as Rule[], conflict: queryConflict(value) }
    : { rules: [] as Rule[], conflict: "first" as const };
  } catch { return { rules: [] as Rule[], conflict: "first" as const }; } };
const sourceName = (source: ResearchSource) => source.reference.title || source.reference.citation || source.reference.id;
const expandSelection = (selected: Set<string> | null, children: Map<string | null, ResearchLabel[]>) => {
  if (selected === null) return null; const ids = new Set(selected);
  for (const id of ids) if (id !== UNSORTED) children.get(id)?.forEach(({ id: child }) => ids.add(child)); return ids;
};
const itemSelected = (ids: string[], selected: Set<string> | null) => selected === null ||
  selected.has(UNSORTED) && !ids.length || ids.some((id) => selected.has(id));
const passageSelected = (source: ResearchSource, selected: Set<string> | null) => selected === null ||
  !!source.passages && (selected.has(UNSORTED) && source.passages.unlabelledCount > 0 ||
    [...selected].some((id) => (source.passages?.labelCounts[id] ?? 0) > 0));

function ChoiceMenu({ label, value, options, onChange, className = "" }: { label: string; value: string;
  options: readonly { value: string; label: string }[]; onChange: (value: string) => void; className?: string;
}) { const selected = options.find((option) => option.value === value)?.label;
  return <ActionMenu label={label} className={`min-w-0 ${className}`} items={options.map((option) => ({
    label: option.label, checked: option.value === value, onSelect: () => onChange(option.value) }))}
    triggerClassName="h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-2 text-sm text-gray-800 hover:border-gray-500">
    <span className="truncate">{selected}</span><ChevronDown aria-hidden="true" className="size-3.5" />
  </ActionMenu>; }

type Props = { file: ResearchFile | null; projectId?: string; onChange: (file: ResearchFile) => void;
  rail?: HTMLElement | null; mutations?: ResearchFileMutations; sourceDropNonce?: number;
  onReadSource?: (source: ResearchSource, locator?: string) => void; selectedSourceId?: string };
export function ResearchFileBar(props: Props) {
  return <ResearchFileBarContent key={props.file?.document.id ?? "empty"} {...props} />;
}
function ResearchFileBarContent({ file, projectId, onChange, rail, mutations, sourceDropNonce, onReadSource, selectedSourceId }: Props) {
  const localMutations = useResearchFileMutations(file, onChange), commit = mutations ?? localMutations;
  const root = useRef<HTMLDivElement>(null), [wide, setWide] = useState(false);
  const [labelsChoice, setLabelsOpen] = useState<boolean | null>(null), labelsOpen = labelsChoice ?? wide;
  useLayoutEffect(() => { const node = root.current; if (!node) return;
    const breakpoint = 44 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);
    setWide(node.getBoundingClientRect().width >= breakpoint);
    const observer = new ResizeObserver(([entry]) => setWide(entry.contentRect.width >= breakpoint));
    observer.observe(node); return () => observer.disconnect(); }, []);
  const [labelScope, setLabelScope] = useState<Scope>("source"),
    [searchOpen, setSearchOpen] = useState(false);
  const [open, setOpen] = useState(false), [selectedDocuments, setSelectedDocuments] = useState<Document[]>([]);
  const [createOpen, setCreateOpen] = useState(false), [renameOpen, setRenameOpen] = useState(false),
    [noteOpen, setNoteOpen] = useState(false), [noteDraft, setNoteDraft] = useState(file?.state.note ?? "");
  const [folderOpen, setFolderOpen] = useState(false), [projectOpen, setProjectOpen] = useState(false),
    [directoryKey, setDirectoryKey] = useState(0), [folderError, setFolderError] = useState(""),
    [openLocation, setOpenLocation] = useState<DirectoryLocation>(() => projectId ?? file?.document.project_id
      ? { projectId: projectId ?? file!.document.project_id! } : { library: "files" }),
    [createFolder, setCreateFolder] = useState<Folder | null>(null);
  const [sourceSelected, setSourceSelected] = useState<Set<string> | null>(null),
    [highlightSelected, setHighlightSelected] = useState<Set<string> | null>(null), [highlightFilter, setHighlightFilter] = useState(false),
    [activeLabel, setActiveLabel] = useState<string | null>(null),
    [matches, setMatches] = useState<{ evidence: Set<string>; sources: Set<string> } | null>(null);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(file?.document.id)),
    [labelSearch, setLabelSearch] = useState<Record<Scope, string>>({ source: "", highlight: "" }),
    [labelDrop, setLabelDrop] = useState<LabelDrop | null>(null), [openedSources, setOpenedSources] = useState<Set<string>>(() => new Set());
  const [listSearch, setListSearch] = useState("");
  const [sort, setSort] = useState("saved"), [kindFilter, setKindFilter] = useState<Set<string>>(() => new Set()),
    [yearFilter, setYearFilter] = useState<Set<string>>(() => new Set()), [collectionFilter, setCollectionFilter] = useState<Set<string>>(() => new Set()),
    [page, setPage] = useState(0), [recipe, setRecipe] = useState(() => readRecipe(file?.document.id));
  const [plain, setPlain] = useState(""), [syntax, setSyntax] = useState<"literal" | "terms">("literal"),
    [target, setTarget] = useState<"sources" | "passages">("sources"), [historyOpen, setHistoryOpen] = useState(false),
    [openQueries, setOpenQueries] = useState<Set<string>>(() => new Set());
  const [ruleEditor, setRuleEditor] = useState<number | null>(null);
  const [searchResult, setSearchResult] = useState<{ input: ResearchQueryInput; coverage: ResearchQueryCoverage } | null>(null);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState("");
  const [removing, setRemoving] = useState<{ kind: "label" | "source" | "evidence"; id: string; name: string; sourceId?: string } | null>(null);
  const labelDrag = useRef<string | null>(null), handledDrop = useRef(0), returnToPicker = useRef(false),
    labelsButton = useRef<HTMLButtonElement>(null), searchButton = useRef<HTMLButtonElement>(null);
  const closeLabels = () => { setLabelsOpen(false); labelsButton.current?.focus({ preventScroll: true }); };
  const closeSearch = () => { setSearchOpen(false); searchButton.current?.focus({ preventScroll: true }); };
  const revealLabels = useCallback(() => { setLabelsOpen(true); setLabelScope("source"); setSearchOpen(false); }, []);
  const toggleQuery = (id: string) => setOpenQueries((values) => { const next = new Set(values);
    if (next.has(id)) next.delete(id); else next.add(id); return next; });
  const directory = useMemo(() => directoryResource(file?.document.project_id
    ? { projectId: file.document.project_id } : { library: "files" }), [file?.document.project_id]);
  const createProjectId = "projectId" in openLocation ? openLocation.projectId : null;
  const createDirectory = useMemo(() => directoryResource(createProjectId
    ? { projectId: createProjectId } : { library: "files" }), [createProjectId]);
  const labels = useMemo(() => file?.state.labels ?? {}, [file?.state.labels]);
  const allSources = useMemo(() => Object.values(file?.state.sources ?? {}), [file?.state.sources]);
  const passageRevisions = useMemo(() => Object.fromEntries(allSources.map(({ id, passages }) =>
    [id, passages?.sha256 ?? ""])), [allSources]);
  const queryPages = usePagedChains<ResearchPageItem>((_key, cursor, signal) => getResearchItems(file!.document.id,
    { kind: "queries", cursor, limit: PAGE_SIZE }, signal), [file?.document.id],
    "queries", !!file && historyOpen && searchOpen, { queries: file?.state.queries?.sha256 ?? "" });
  const queryCount = file?.state.queries?.count ?? 0;
  const children = useMemo(() => { const map = new Map<string | null, ResearchLabel[]>();
    Object.values(labels).forEach((label) => { const values = map.get(label.parentId) ?? [];
      values.push(label); map.set(label.parentId, values); });
    map.forEach((values) => values.sort((a, b) => a.order - b.order)); return map; }, [labels]);
  const sourceLabelIds = useMemo(() => expandSelection(sourceSelected, children), [sourceSelected, children]);
  const highlightLabelIds = useMemo(() => expandSelection(highlightSelected, children), [highlightSelected, children]);
  const appliedHighlightIds = highlightFilter ? highlightLabelIds : null;
  const passagePages = usePagedChains<ResearchPageItem>(async (key, cursor, signal) => {
    // Advance past nonmatching source pages before presenting a filtered page.
    let page;
    do {
      page = await getResearchItems(file!.document.id,
        { kind: "passages", sourceId: key, cursor, limit: PAGE_SIZE }, signal);
      page.items = page.items.filter((item) => item.kind === "passage" &&
        itemSelected(item.value.labelIds, appliedHighlightIds) &&
        (matches === null || matches.evidence.has(item.value.receipt.evidence_id)));
      cursor = page.next_cursor;
    } while (!signal.aborted && !page.items.length && cursor);
    return page;
  }, [file?.document.id, appliedHighlightIds, matches], "*", false, passageRevisions);
  useEffect(() => {
    for (const id of openedSources) if (!passagePages.chains[id])
      void passagePages.fetchPage(id, null, false);
  }, [openedSources, passagePages.chains, passagePages.fetchPage]);
  const scopedSources = useMemo(() => allSources.filter((source) => itemSelected(source.labelIds, sourceLabelIds) &&
    passageSelected(source, appliedHighlightIds)), [allSources, sourceLabelIds, appliedHighlightIds]);
  const years = useMemo(() => [...new Set(allSources.map(({ reference }) => reference.date?.slice(0, 4))
    .filter((value): value is string => !!value))].sort().reverse(), [allSources]);
  const filteredSources = useMemo(() => scopedSources.filter((source) => { const haystack = [source.reference.title, source.reference.citation,
    source.reference.collection, source.note].join(" ").toLowerCase(); return haystack.includes(listSearch.toLowerCase()) &&
      (!kindFilter.size || kindFilter.has(source.reference.kind)) && (!yearFilter.size || yearFilter.has(source.reference.date?.slice(0, 4) ?? "")) &&
      (!collectionFilter.size || collectionFilter.has(source.reference.collection ?? "")); })
    .sort((a, b) => sort === "az" ? sourceName(a).localeCompare(sourceName(b)) : sort === "date"
      ? String(b.reference.date ?? "").localeCompare(String(a.reference.date ?? "")) : 0),
    [scopedSources, listSearch, kindFilter, yearFilter, collectionFilter, sort]);
  const list = useMemo(() => filteredSources.filter((source) => matches === null || matches.sources.has(source.id)),
    [filteredSources, matches]);
  const labelCounts = useMemo(() => { const counts: Record<string, number> = {};
    const visit = (items: typeof allSources, scope: Scope) => items.forEach(({ labelIds }) => {
      const applied = new Set<string>(); labelIds.forEach((id) => researchLabelPath(labels, id).forEach((label) => {
        if (label.scope === scope) applied.add(label.id); })); applied.forEach((id) => { counts[id] = (counts[id] ?? 0) + 1; }); });
    visit(allSources, "source"); allSources.forEach(({ passages }) => Object.entries(passages?.labelCounts ?? {})
      .forEach(([id, count]) => { if (labels[id]?.scope === "highlight") counts[id] = (counts[id] ?? 0) + count; }));
    return counts;
  }, [labels, allSources]);
  const unlabelledCount = allSources.reduce((sum, source) => sum +
    (source.passages?.unlabelledCount ?? 0), 0);
  useEffect(() => { if (file) localStorage.setItem(`${COLLAPSED}:${file.document.id}`,
    JSON.stringify([...collapsed])); }, [collapsed, file]);
  useEffect(() => { if (sourceDropNonce && handledDrop.current !== sourceDropNonce) {
    handledDrop.current = sourceDropNonce; revealLabels(); } }, [revealLabels, sourceDropNonce]);
  useEffect(() => { localStorage.setItem(`${RECIPE}:${file?.document.id ?? "empty"}`, JSON.stringify(recipe)); }, [file?.document.id, recipe]);
  useEffect(() => { if (open) setSelectedDocuments(file ? [file.document] : []); }, [open, file]);
  useEffect(() => { if (!noteOpen) setNoteDraft(file?.state.note ?? ""); }, [file?.state.note, noteOpen]);
  useEffect(() => setPage(0), [listSearch, kindFilter, yearFilter, collectionFilter, sourceSelected, highlightSelected]);
  useEffect(() => setPage((current) => Math.min(current,
    Math.max(0, Math.ceil(list.length / PAGE_SIZE) - 1))), [list.length]);

  async function act(action: ResearchAction) {
    if (!file) return null; setStatus("");
    try { return await commit.act(action); }
    catch (reason) { setStatus(errorMessage(reason, "Could not update workspace")); return null; }
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
      projectId: "projectId" in openLocation ? openLocation.projectId : undefined,
      ...(createFolder ? { folderId: createFolder.id } : {}) });
      returnToPicker.current = false; setCreateOpen(false); return next; });
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
    const activeProject = projectId ?? ("projectId" in openLocation ? openLocation.projectId : null);
    if (!name) return; setBusy(true); setFolderError("");
    try { await directoryResource(activeProject ? { projectId: activeProject } : { library: "files" }).createFolder(name, null);
      setDirectoryKey((value) => value + 1); setFolderOpen(false); setOpen(true); returnToPicker.current = false; }
    catch (reason) { setFolderError(errorMessage(reason, "Could not create folder")); }
    finally { setBusy(false); }
  }
  async function addLabel(scope: Scope) {
    if (!file) { setCreateOpen(true); return; }
    setBusy(true); setStatus("");
    try { const id = crypto.randomUUID();
      const selected = scope === "source" ? sourceSelected : highlightSelected, selectedId = selected?.size === 1 ? [...selected][0] : "";
      const parentId = labels[selectedId]?.scope === scope && researchLabelPath(labels, selectedId).length < 3 ? selectedId : null;
      if (parentId) setCollapsed((current) => { const next = new Set(current); next.delete(parentId); return next; });
      await commit.act({ type: "label", id, name: scope === "source" ? "New label" : "New category", parentId, scope,
        color: scope === "source" ? "#3498db" : "#eab308" }); setActiveLabel(id); }
    catch (reason) { setStatus(errorMessage(reason, "Could not add label")); }
    finally { setBusy(false); }
  }
  async function editLabel(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault(); const label = labels[id], data = new FormData(event.currentTarget), name = String(data.get("name") ?? "").trim();
    if (label && name && await act({ type: "label", ...label, name,
      color: String(data.get("color") ?? researchLabelColor(label)) })) setActiveLabel(null);
  }
  function canReparent(id: string, parentId: string | null) {
    const label = labels[id], parent = parentId ? labels[parentId] : null;
    if (!label || id === parentId || parentId && (!parent || parent.scope !== label.scope ||
      researchLabelPath(labels, parentId).some((item) => item.id === id))) return false;
    const height = (node: string): number => { let value = 1;
      for (const child of children.get(node) ?? []) value = Math.max(value, 1 + height(child.id)); return value; };
    return (parentId ? researchLabelPath(labels, parentId).length : 0) + height(id) <= 3;
  }
  async function reparent(id: string, parentId: string | null, order?: number) {
    const label = labels[id]; if (!label || !canReparent(id, parentId)) return;
    await act({ type: "label", ...label, parentId, order: order ?? label.order });
  }
  function keyMove(label: ResearchLabel, key: string) {
    const siblings = (children.get(label.parentId) ?? []).filter(({ scope }) => scope === label.scope),
      index = siblings.findIndex(({ id }) => id === label.id);
    if (key === "ArrowUp" && index > 0) void reparent(label.id, label.parentId, siblings[index - 1].order - .5);
    else if (key === "ArrowDown" && index + 1 < siblings.length) void reparent(label.id, label.parentId, siblings[index + 1].order + .5);
    else if (key === "ArrowRight" && index > 0) void reparent(label.id, siblings[index - 1].id, children.get(siblings[index - 1].id)?.length ?? 0);
    else if (key === "ArrowLeft" && label.parentId) { const parent = labels[label.parentId];
      if (parent) void reparent(label.id, parent.parentId, parent.order + .5); }
    else return false;
    return true;
  }
  function showMatches(evidenceIds: string[], sourceIds: string[]) {
    setSearchResult(null);
    setMatches({ evidence: new Set(evidenceIds), sources: new Set(sourceIds) }); setSearchOpen(false); setLabelsOpen(false); setPage(0);
  }
  async function query(input: ResearchQueryInput, continuing = false) {
    if (!file) return;
    const selected = input.target === "passages" ? highlightSelected : sourceSelected,
      scoped = sourceSelected !== null || highlightFilter && highlightSelected !== null ||
        !!listSearch.trim() || kindFilter.size > 0 || yearFilter.size > 0 || collectionFilter.size > 0;
    if (!continuing && (selected?.size === 0 || scoped && !filteredSources.length))
      return setStatus(input.target === "passages" ? "No passages selected" : "No sources selected");
    setBusy(true); setStatus("");
    try { const request = continuing ? input : { ...input,
      ...(selected === null ? {} : { labelIds: [...selected].filter((id) => id !== UNSORTED),
        ...(selected.has(UNSORTED) ? { unlabelled: true } : {}) }),
      ...(scoped ? { sourceIds: filteredSources.map(({ id }) => id) } : {}) };
      const result = await commit.query(request);
      const limited = result.receipt.failures.some(({ code }) => code.endsWith("_limit")), failed =
        new Set(result.receipt.failures.filter(({ code }) => !code.endsWith("_limit")).map(({ sourceId }) => sourceId)).size;
      showMatches([...new Set([...(continuing ? matches?.evidence ?? [] : []), ...result.receipt.evidenceIds])],
        [...new Set([...(continuing ? matches?.sources ?? [] : []), ...result.receipt.matchedSourceIds])]);
      setSearchResult(result.coverage ? { input: request, coverage: result.coverage } : null);
      setStatus([`${result.receipt.evidenceIds.length} matches`, limited && "limit reached",
        failed && `${failed} source failure${failed === 1 ? "" : "s"}`].filter(Boolean).join(" · ")); }
    catch (reason) { setStatus(errorMessage(reason, "Search failed")); }
    finally { setBusy(false); }
  }
  function runQuery() {
    const rules = recipe.rules.filter(({ phrase, slot }) => phrase.trim() && slot.trim())
      .map((rule) => ({ ...rule, phrase: rule.phrase.trim(), slot: labels[rule.slot]?.scope === "highlight" ? rule.slot : UNCLASSIFIED }));
    if (rules.length) void query({ syntax: "literal", target: "sources", rules, conflict: recipe.conflict });
    else setStatus("Add a capture rule first");
  }
  function runPlain(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (plain.trim()) void query({ text: plain.trim(), syntax, target });
  }
  function sourceHref(source: ResearchSource, locator?: string) {
    if (source.reference.provider !== "a2aj" && source.reference.provider !== "journal")
      return safeAssistantUrl(source.reference.url, { relative: false });
    const href = legalSourceViewerHref(source.reference,
      file ? { fileId: file.document.id, sourceId: source.id } : undefined);
    return locator ? `${href}&locator=${encodeURIComponent(locator)}` : href;
  }
  function sourceLink(source: ResearchSource, text: string, locator?: string, title = false) {
    const href = sourceHref(source, locator), className = `rounded text-left text-sm hover:text-brand ${title ? "font-semibold leading-5" : "font-medium underline underline-offset-2"}`;
    return onReadSource && (source.reference.provider === "a2aj" || source.reference.provider === "journal")
      ? <button type="button" aria-current={title && selectedSourceId === source.id ? "true" : undefined}
      className={className} onClick={() => onReadSource(source, locator)}>{text}</button>
      : !href ? <span>{text}</span> : href.startsWith("/")
      ? <Link to={href} className={className}>{text}</Link> : <a href={href} className={className}>{text}</a>;
  }
  const editRule = (patch: Partial<Rule>) => setRecipe((current) => ({ ...current,
    rules: current.rules.map((rule, index) => index === ruleEditor ? { ...rule, ...patch } : rule) }));
  const closeRule = () => { setRecipe((current) => ({ ...current,
    rules: current.rules.filter((rule, index) => index !== ruleEditor || !!rule.phrase.trim()) })); setRuleEditor(null); };
  const ruleText = (rule: Rule, paths: Record<string, string> = {}) => `${rule.phrase} → ${rule.direction} ${rule.unit}${rule.unit === "chars" ? ` (${rule.chars ?? 100})` : ""} → ${receiptLabel(labels, rule.slot, paths)}`;
  function matchesLabel(id: string, search: string): boolean { return !search || labels[id].name.toLowerCase().includes(search.toLowerCase()) ||
    (children.get(id) ?? []).some(({ id: child }) => matchesLabel(child, search)); }
  const filterItems = (values: string[], selected: Set<string>, change: (value: Set<string>) => void) =>
    values.map((value) => ({ label: value, checked: selected.has(value), keepOpen: true,
      onSelect: () => { const next = new Set(selected); if (next.has(value)) next.delete(value); else next.add(value); change(next); } }));
  function labelTree(scope: Scope, parentId: string | null, depth = 0): ReactNode {
    const search = labelSearch[scope], selection = scope === "source" ? sourceSelected : highlightSelected;
    return (children.get(parentId) ?? []).filter((label) => label.scope === scope && matchesLabel(label.id, search)).map((label) => {
      const hasChildren = !!children.get(label.id)?.length, open = !collapsed.has(label.id) || !!search,
        count = labelCounts[label.id] ?? 0;
      return <div key={label.id}>
        <div data-tree-drop-folder={label.id} draggable tabIndex={0} onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.altKey && keyMove(label, event.key)) { event.preventDefault(); event.stopPropagation(); } }}
          onDragStart={(event) => {
          if ((event.target as Element).closest("button,input,label,form,a")) { event.preventDefault(); return; }
          labelDrag.current = label.id; event.dataTransfer.setData(LABEL_DRAG, label.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => { labelDrag.current = null; setLabelDrop(null); }}
          title="Drag to reorder or move into another label" onDragOver={(event) => {
            const sourceDrag = event.dataTransfer.types.includes(RESEARCH_SOURCE_DRAG) ||
              event.dataTransfer.types.includes(RESEARCH_SOURCE_REFERENCE_DRAG);
            const dragged = labels[labelDrag.current ?? ""];
            if (sourceDrag ? scope !== "source" : !event.dataTransfer.types.includes(LABEL_DRAG) || dragged?.scope !== scope)
              return setLabelDrop(null);
            const box = event.currentTarget.getBoundingClientRect(), y = (event.clientY - box.top) / box.height,
              mode = sourceDrag ? "inside" : event.clientX - box.left > Math.min(96, box.width * .55)
                ? "inside" : y < .5 ? "before" : "after";
            if (!sourceDrag && !canReparent(dragged.id, mode === "inside" ? label.id : label.parentId))
              return setLabelDrop(null);
            event.preventDefault(); setLabelDrop({ id: label.id, mode }); }} onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node)) setLabelDrop(null); }} onDrop={(event) => { event.preventDefault(); setLabelDrop(null);
            const sourceId = event.dataTransfer.getData(RESEARCH_SOURCE_DRAG), source = file?.state.sources[sourceId];
            if (scope === "source" && source) { void act({ type: "annotate", kind: "source", id: sourceId,
              labelIds: [label.id, ...source.labelIds.filter((id) => id !== label.id)] }); return; }
            const raw = event.dataTransfer.getData(RESEARCH_SOURCE_REFERENCE_DRAG);
            if (scope === "source" && raw) { try { void act({ type: "source", reference: JSON.parse(raw), labelIds: [label.id] }); } catch { /* Invalid drag payload. */ } return; }
            const drop = labelDrop?.id === label.id ? labelDrop.mode : "inside"; labelDrag.current = null;
            void reparent(event.dataTransfer.getData(LABEL_DRAG), drop === "inside" ? label.id : label.parentId,
              drop === "inside" ? children.get(label.id)?.length ?? 0 : label.order + (drop === "before" ? -.5 : .5)); }}
          className={`group relative flex h-9 w-full min-w-0 items-center gap-1.5 rounded-md pe-1 ${labelDrop?.id === label.id
            ? labelDrop.mode === "inside" ? "bg-blue-50 ring-1 ring-inset ring-blue-300"
              : labelDrop.mode === "before" ? "before:absolute before:inset-x-1 before:top-0 before:h-0.5 before:rounded before:bg-brand"
                : "after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded after:bg-brand"
            : selection?.has(label.id) ? "bg-gray-100" : "hover:bg-gray-50"}`}
          style={{ paddingInlineStart: 8 + depth * 16 }}>
          <GripVertical aria-hidden="true" className="size-3 shrink-0 cursor-grab text-gray-300 group-hover:text-gray-500" />
          <button type="button" disabled={!hasChildren} aria-label={`${open ? "Collapse" : "Expand"} ${label.name}`}
            onClick={() => setCollapsed((current) => { const next = new Set(current); if (next.has(label.id)) next.delete(label.id); else next.add(label.id); return next; })}
            className="grid size-6 shrink-0 place-items-center rounded disabled:invisible">
            {open ? <ChevronDown aria-hidden="true" className="size-3.5" /> : <ChevronRight aria-hidden="true" className="size-3.5" />}
          </button>
          <label title={`Change ${label.name} colour`} className="relative grid size-6 shrink-0 cursor-pointer place-items-center rounded focus-within:outline focus-within:outline-2 focus-within:outline-offset-1">
            <FolderSvgIcon open={open} className="size-4" fill="currentColor" style={{ color: researchLabelColor(label) }} />
            <input type="color" value={researchLabelColor(label)} aria-label={`${label.name} color`}
              onClick={(event) => event.stopPropagation()} onChange={(event) => { const color = event.target.value;
                if (!file) return; onChange({ ...file, state: { ...file.state,
                  labels: { ...labels, [label.id]: { ...label, color } } } });
                void act({ type: "label", ...label, color }).then((saved) => { if (!saved)
                  void getResearchFile(file.document.id).then(onChange).catch(() => undefined); }); }}
              className="absolute inset-0 cursor-pointer opacity-0" />
          </label>
          {activeLabel === label.id ? <form onSubmit={(event) => void editLabel(event, label.id)} className="flex min-w-0 flex-1 items-center gap-1">
            <input required autoFocus name="name" aria-label="Label name" defaultValue={label.name}
              onBlur={(event) => event.currentTarget.form?.requestSubmit()}
              onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); setActiveLabel(null); } }}
              className="h-7 min-w-0 flex-1 rounded border border-gray-300 px-1.5 text-sm" />
          </form> : <><button type="button" onClick={(event) => { const set = scope === "source" ? setSourceSelected : setHighlightSelected;
            set((current) => { if (!event.shiftKey) return new Set([label.id]); const next = new Set(current ?? []);
              if (next.has(label.id)) next.delete(label.id); else next.add(label.id); return next; }); }}
            aria-pressed={selection?.has(label.id) ?? false}
            aria-label={`${label.name}, ${count} ${scope === "source" ? "sources" : "directly labelled passages"}`}
            title={scope === "highlight" ? `${count} directly labelled passages; selecting includes nested labels` : undefined}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1 text-left text-sm font-medium">
            <span className="min-w-0 flex-1 truncate">{label.name}</span><span className="tabular-nums text-gray-500">{count}</span>
          </button><button type="button" onClick={() => setActiveLabel(label.id)} aria-label={`Edit ${label.name}`}
            className="absolute end-1 grid size-7 place-items-center rounded bg-white/90 text-gray-500 opacity-0 hover:bg-gray-100 focus-visible:opacity-100 group-hover:opacity-100"><Pencil className="size-3" aria-hidden="true" /></button></>}
        </div>{hasChildren && open && labelTree(scope, label.id, depth + 1)}
      </div>;
    });
  }

  function labelPanel(scope: Scope) { const selection = scope === "source" ? sourceSelected : highlightSelected,
    setSelection = scope === "source" ? setSourceSelected : setHighlightSelected;
    return <><div className="mb-1 flex items-center gap-1">
      <button type="button" aria-pressed={selection === null} onClick={() => setSelection(null)} className={`rounded px-2 py-1 text-sm font-semibold ${selection === null ? "bg-gray-200" : "hover:bg-gray-100"}`}>View all</button>
      <button type="button" aria-pressed={selection?.size === 0} onClick={() => setSelection(new Set())} className={`rounded px-2 py-1 text-sm font-semibold text-gray-500 ${selection?.size === 0 ? "bg-gray-200" : "hover:bg-gray-100"}`}>View none</button>
    </div>
      <input type="search" value={labelSearch[scope]} onChange={(event) => setLabelSearch((value) => ({ ...value, [scope]: event.target.value }))}
        aria-label={scope === "source" ? "Search labels" : "Search highlight categories"}
        placeholder={scope === "source" ? "Search labels" : "Search categories"}
        className="mb-1 h-8 w-full min-w-0 rounded-md border border-gray-300 px-2 text-sm" />
    {scope === "highlight" && <label className="mb-1 flex items-center gap-1 rounded bg-gray-50 px-1.5 py-1 text-[13px] leading-4 text-gray-600">
      <input type="checkbox" checked={highlightFilter} onChange={(event) => setHighlightFilter(event.target.checked)} />
      Filter sources by these passages
    </label>}
    <div>{labelTree(scope, null)}</div>
    {scope === "highlight" && unlabelledCount > 0 && <button type="button"
      aria-pressed={selection?.has(UNSORTED) ?? false}
      onClick={() => setSelection(new Set([UNSORTED]))}
      className={`mt-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${selection?.has(UNSORTED) ? "bg-gray-200" : "hover:bg-gray-50"}`}>
      <ResearchLabelCircle labels={labels} labelIds={[]} size="sm" />Unclassified
      <span className="ms-auto tabular-nums text-gray-400">{unlabelledCount}</span>
    </button>}
    {scope === "source" && <button type="button" aria-pressed={selection?.has(UNSORTED) ?? false} onClick={() => setSelection(new Set([UNSORTED]))}
      className={`mt-1 flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium text-gray-500 ${selection?.has(UNSORTED) ? "bg-gray-200" : "hover:bg-gray-50"}`}>
      <ResearchLabelCircle labels={labels} labelIds={[]} size="sm" />Unsorted
    </button>}
    <button type="button" data-tree-drop-root={scope} disabled={busy} onClick={() => void addLabel(scope)}
      onDragOver={(event) => { const dragged = labels[labelDrag.current ?? ""];
        if (dragged?.scope !== scope || !canReparent(dragged.id, null)) return setLabelDrop(null);
        event.preventDefault(); setLabelDrop({ id: `root:${scope}`, mode: "inside" }); }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setLabelDrop(null); }}
      onDrop={(event) => { event.preventDefault(); setLabelDrop(null); labelDrag.current = null;
        const id = event.dataTransfer.getData(LABEL_DRAG);
        if (labels[id]?.scope === scope) void reparent(id, null, children.get(null)?.filter((label) => label.scope === scope).length ?? 0); }}
      className={`mt-1 flex h-9 w-full items-center rounded-md border border-dashed px-2 text-left text-sm text-gray-500 hover:text-gray-800 ${labelDrop?.id === `root:${scope}`
        ? "border-brand bg-blue-50 ring-1 ring-inset ring-blue-300" : "border-gray-300 hover:border-gray-500"}`}>
      {labelDrop?.id === `root:${scope}` ? "Move to top level" : `+ Add ${scope === "source" ? "label" : "category"}`}
    </button></>; }
  const listPanel = () => <>
    <div className="mb-3 flex items-center gap-2">
      <input type="search" value={listSearch} onChange={(event) => setListSearch(event.target.value)} aria-label="Search list"
        placeholder="Filter sources" className="h-9 min-w-0 flex-1 rounded-md border border-gray-300 px-2 text-sm" />
      <ChoiceMenu className="w-32 shrink-0" label="Sort sources" value={sort} onChange={setSort} options={[
        { value: "saved", label: "Saved order" }, { value: "az", label: "A–Z" }, { value: "date", label: "Date" }]} />
    </div>
    <details className="mb-3"><summary className="cursor-pointer text-sm font-medium text-gray-600">Filters{kindFilter.size + yearFilter.size + collectionFilter.size > 0 ? ` (${kindFilter.size + yearFilter.size + collectionFilter.size})` : ""}</summary>
    <div className="mt-2 grid grid-cols-3 gap-2 text-sm text-gray-600">
      <ActionMenu label="Filter source type" items={filterItems([...new Set(allSources.map(({ reference }) => reference.kind))], kindFilter, setKindFilter)
        .map((item) => ({ ...item, label: item.label.replace(/^./u, (letter) => letter.toUpperCase()) }))}
        triggerClassName={`h-8 w-full min-w-0 items-center justify-between gap-1 overflow-hidden whitespace-nowrap rounded-md border border-gray-300 bg-white px-2 text-sm ${kindFilter.size ? "font-semibold text-gray-900" : ""}`}><span className="truncate">Type{kindFilter.size ? ` (${kindFilter.size})` : ""}</span><ChevronDown className="size-3 shrink-0" /></ActionMenu>
      <ActionMenu label="Filter year" items={filterItems(years, yearFilter, setYearFilter)}
        triggerClassName={`h-8 w-full min-w-0 items-center justify-between gap-1 overflow-hidden whitespace-nowrap rounded-md border border-gray-300 bg-white px-2 text-sm ${yearFilter.size ? "font-semibold text-gray-900" : ""}`}><span className="truncate">Year{yearFilter.size ? ` (${yearFilter.size})` : ""}</span><ChevronDown className="size-3 shrink-0" /></ActionMenu>
      <ActionMenu label="Filter collection" className="min-w-0" items={filterItems([...new Set(allSources.map(({ reference }) => reference.collection).filter((value): value is string => typeof value === "string"))], collectionFilter, setCollectionFilter)}
        triggerClassName={`h-8 w-full min-w-0 items-center justify-between gap-1 overflow-hidden whitespace-nowrap rounded-md border border-gray-300 bg-white px-2 text-sm ${collectionFilter.size ? "font-semibold text-gray-900" : ""}`}><span className="truncate">Collection{collectionFilter.size ? ` (${collectionFilter.size})` : ""}</span><ChevronDown className="size-3 shrink-0" /></ActionMenu>
    </div></details>
    <div className="mt-1 min-h-0">
    <div className="mb-1 flex items-center text-sm"><span role="status" className="tabular-nums text-gray-600">{list.length} {list.length === 1 ? "source" : "sources"}</span></div>
    {list.length ? <ol>{list.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((source) => {
      const sourcePage = passagePages.chains[source.id], evidence = (sourcePage?.items.flatMap((item) =>
        item.kind === "passage" ? [item.value] : []) ?? []);
      return <li key={source.id} className={`border-b border-gray-200 last:border-0 ${selectedSourceId === source.id ? "bg-gray-100" : ""}`}><details open={openedSources.has(source.id)} className="group rounded hover:bg-gray-50" onToggle={(event) => {
        const isOpen = event.currentTarget.open; setOpenedSources((current) => { const next = new Set(current);
        if (isOpen) next.add(source.id); else next.delete(source.id); return next; }); }}><summary className="flex list-none items-start gap-2 px-1 py-3 text-sm" onClick={(event) => {
          if (!(event.target as Element).closest("button,a")) event.preventDefault(); }}>
        <button type="button" aria-label={`Passages in ${sourceName(source)}`} aria-expanded={openedSources.has(source.id)}
          onClick={(event) => { event.preventDefault(); setOpenedSources((current) => { const next = new Set(current);
            if (next.has(source.id)) next.delete(source.id); else next.add(source.id); return next; }); }}
          className="grid size-5 shrink-0 place-items-center rounded hover:bg-gray-200"><ChevronRight aria-hidden="true" className="size-3 text-gray-500 group-open:rotate-90" /></button>
        <ResearchLabelPicker file={file} kind="source" itemId={source.id} labelIds={source.labelIds}
          badge={source.badge} badgeColor={source.badgeColor} note={source.note} title={sourceName(source)} size="sm"
          onError={setStatus} onSourceDrag={revealLabels} mutations={commit} />
        <span className="min-w-0 flex-1"><span className="block break-words">{sourceLink(source, sourceName(source), undefined, true)}</span>
          {source.reference.citation && source.reference.citation !== sourceName(source) && <span className="mt-0.5 block text-sm text-gray-600">{source.reference.citation}</span>}
          {source.note && <span className="mt-0.5 line-clamp-1 whitespace-pre-wrap font-normal text-gray-600 group-open:line-clamp-none">{source.note}</span>}</span>
        <span className="shrink-0 text-sm tabular-nums text-gray-500" title="Saved passages">{source.passages?.count ?? 0}</span>
      </summary>{openedSources.has(source.id) && <div className="space-y-3 ps-6 pe-2 pb-3 text-sm leading-5">
        <div className="flex items-center justify-between text-gray-500"><span>{source.passages?.count ?? 0} passages</span>
          {sourceHref(source) && sourceLink(source, "Open source")}</div>
        {sourcePage?.loading && !sourcePage.items.length && <p role="status" className="text-xs text-gray-500">Loading passages…</p>}
        {!!sourcePage?.error && <button type="button" onClick={() => void passagePages.fetchPage(source.id, null, false)}
          className="text-sm font-medium text-red-700">Retry passages</button>}
        {evidence.map((item) => <div key={item.receipt.evidence_id} className="border-s-2 border-gray-200 ps-2">
          <div className="flex items-center gap-1"><ResearchLabelPicker file={file} kind="evidence" itemId={item.receipt.evidence_id} sourceId={source.id}
            labelIds={item.labelIds} note={item.note} title={item.receipt.locator.label} size="sm"
            onError={setStatus} mutations={commit} />
            {sourceLink(source, item.receipt.locator.label, item.receipt.locator.label)}
            <button type="button" aria-label={`Delete ${item.receipt.locator.label}`} onClick={() => setRemoving({ kind: "evidence", id: item.receipt.evidence_id, sourceId: source.id, name: item.receipt.locator.label })}
              className="ms-auto grid size-6 place-items-center rounded text-gray-400 hover:bg-gray-200 hover:text-red-700"><Trash2 className="size-3" /></button></div>
          <p className="line-clamp-3 text-gray-600">{item.receipt.span_text}</p>{item.note && <p className="mt-0.5 text-gray-700">{item.note}</p>}
        </div>)}
        {sourcePage?.nextCursor && <button type="button" aria-label={`Show more passages from ${sourceName(source)}`}
          disabled={sourcePage.loading} onClick={() => void passagePages.fetchPage(source.id, sourcePage.nextCursor, true)}
          className="w-full rounded py-1 text-xs font-medium text-gray-500 hover:bg-gray-100 disabled:opacity-40">Show more passages</button>}
        <button type="button" onClick={() => setRemoving({ kind: "source", id: source.id, name: sourceName(source) })}
          className="text-xs text-gray-400 hover:text-red-700">Remove source</button>
      </div>}</details></li>;
    })}</ol> : <p className="p-2 text-xs text-gray-500">No sources in this view.</p>}
    {list.length > PAGE_SIZE && <div className="mt-2 flex items-center justify-center gap-2 text-xs"><button type="button" disabled={!page} onClick={() => setPage(page - 1)}>Previous</button>
      <span>Page {page + 1} of {Math.ceil(list.length / PAGE_SIZE)}</span><button type="button" disabled={(page + 1) * PAGE_SIZE >= list.length} onClick={() => setPage(page + 1)}>Next</button></div>}
    </div></>;
  const queryChain = queryPages.chains.queries,
    historyQueries = queryChain?.items.flatMap((item) => item.kind === "query" ? [item.value] : []) ?? [];
  const searchPanel = () => file ? <>
    <form onSubmit={runPlain} className="mb-2 grid grid-cols-2 gap-1.5 border-b border-gray-200 pb-2">
      <input required value={plain} onChange={(event) => setPlain(event.target.value)} aria-label="Search saved source text"
        placeholder="Find in saved text" className="col-span-2 h-8 min-w-0 rounded-md border border-gray-300 px-2 text-sm" />
      <ChoiceMenu label="Search syntax" value={syntax} onChange={(value) => setSyntax(value as typeof syntax)}
        options={[{ value: "literal", label: "Exact" }, { value: "terms", label: "All terms" }]} />
      <ChoiceMenu label="Search target" value={target} onChange={(value) => setTarget(value as typeof target)}
        options={[{ value: "sources", label: "Source text" }, { value: "passages", label: "Saved passages" }]} />
      <button disabled={busy} className="col-span-2 h-8 rounded-md bg-gray-900 px-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-40">Find passages</button>
    </form>
    <div className="mb-2 mt-1.5 flex gap-1.5">
      <button type="button" onClick={() => { setRuleEditor(recipe.rules.length); setRecipe((current) => ({ ...current,
        rules: [...current.rules, { phrase: "", direction: "after", unit: "sentence", slot: UNCLASSIFIED }] })); }}
        className="inline-flex h-8 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-md border border-gray-300 bg-white px-1.5 text-[13px] font-medium text-gray-700 hover:bg-gray-50"><Plus className="size-3.5" />Add rule</button>
      <button type="button" disabled={busy} onClick={runQuery}
        className="h-8 flex-1 whitespace-nowrap rounded-md bg-brand px-1.5 text-[13px] font-medium text-white hover:bg-brand-dark disabled:opacity-40">Run rules</button>
    </div>
    <div className="space-y-1">{recipe.rules.map((rule, index) => <div key={index}
      className="flex min-h-8 items-center gap-1 rounded bg-gray-50 px-1.5 text-xs">
      <button type="button" onClick={() => setRuleEditor(index)}
        className="min-w-0 flex-1 truncate text-left hover:underline">{ruleText(rule)}</button>
      <button type="button" onClick={() => setRecipe((current) => ({ ...current,
        rules: current.rules.filter((_, item) => item !== index) }))} aria-label={`Remove rule ${index + 1}`}
        className="grid size-6 place-items-center rounded text-gray-400 hover:bg-gray-200 hover:text-red-700"><X className="size-3" /></button>
    </div>)}</div>
    <label className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-xs text-gray-600">When rules overlap
      <ChoiceMenu label="Conflict policy" value={recipe.conflict} onChange={(value) => setRecipe((current) => ({ ...current, conflict: value as typeof current.conflict }))}
        options={[{ value: "prompt", label: "Keep for review" }, { value: "first", label: "First rule wins" }, { value: "longer", label: "Longer passage" }, { value: "shorter", label: "Shorter passage" }, { value: "append", label: "Keep both" }]} />
    </label>
    {!!queryCount && <details open={historyOpen}
      className="group/history mt-2 overflow-hidden rounded-md border border-gray-200 text-xs text-gray-600">
      <summary onClick={(event) => { event.preventDefault(); setHistoryOpen((open) => !open); }} className="flex h-8 cursor-pointer list-none items-center gap-1.5 bg-gray-50 px-2 font-medium text-gray-800">
        <ChevronRight className="size-3.5 group-open/history:rotate-90" aria-hidden="true" />Search history
        <span className="ms-auto tabular-nums text-gray-500">{queryCount}</span>
      </summary>{historyOpen && <div className="space-y-1.5 border-t border-gray-200 p-2">
      <ol className="space-y-1">{historyQueries
        .map((item) => { const openQuery = openQueries.has(item.query_id), saved = openQuery ? queryRules(item.input) : [],
          scopeLabels = openQuery && Array.isArray(item.input.label_ids)
            ? item.input.label_ids.map((id) => receiptLabel(labels, String(id), item.labelPaths)) : [],
          failures = new Map(item.failures.map((value) => [value.sourceId, value.code])),
          searched = openQuery ? item.sourceIds.map((id) => { const source = file.state.sources[id],
            reference = source?.reference ?? item.sourceReferences?.[id], failure = failures.get(id);
            return `${source ? sourceName(source) : reference?.title || reference?.citation || reference?.id || id}${failure ? ` · ${failure}` : ""}`; }).join("\n") : "",
          audit = openQuery ? item.sourceIds.map((id) => {
            const hashes = item.sourceFingerprints?.[id], failure = failures.get(id);
            return `[${id}]${hashes?.length ? ` · ${hashes.join(", ")}` : ""}${failure ? ` · ${failure}` : ""}`; }).join("\n") : "";
          return <li key={item.query_id}>
        <details open={openQuery} className="group/query rounded-md border border-gray-200 bg-white"><summary
          onClick={(event) => { event.preventDefault(); toggleQuery(item.query_id); }} className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5">
          <ChevronRight className="size-3 group-open/query:rotate-90" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate font-medium text-gray-800">{queryText(item.input)}</span>
          <span className="shrink-0 tabular-nums text-gray-500">{item.evidenceIds.length} matches</span></summary>
          {openQuery && <div className="space-y-1 border-t border-gray-100 px-2 py-1.5 leading-4">
          <p>{saved.length ? saved.map((rule) => ruleText(rule, item.labelPaths)).join("; ") : `${String(item.input.syntax ?? "literal")} · ${String(item.input.target ?? "sources")}`}</p>
          <p className="text-gray-500">{new Date(item.executed_at).toLocaleString()} · {item.model || "human"} · {item.sourceIds.length} sources · {item.failures.length} failures</p>
          {!!scopeLabels.length && <p>Scope: {scopeLabels.join(", ")}</p>}
          {searched && <p aria-label="Sources searched" className="whitespace-pre-wrap">{searched}</p>}
          {!!Object.keys(item.slots).length && <p>Slots: {slotSummary(item.slots, labels, item.labelPaths)}</p>}
          {audit && <details className="rounded bg-gray-50"><summary className="cursor-pointer px-1.5 py-1 font-medium">Technical details</summary>
            <pre aria-label="Search fingerprints" className="max-h-28 overflow-y-auto whitespace-pre-wrap break-all px-1.5 pb-1.5 text-xs">{audit}</pre>
          </details>}
          {(!!saved.length || !!item.evidenceIds.length) && <div className="mt-1 flex flex-wrap gap-1">
            {!!saved.length && <button type="button" onClick={() => setRecipe({ rules: saved, conflict: queryConflict(item.input) })}
              className="rounded border px-2 py-1 font-medium text-gray-700 hover:bg-gray-50">Use these rules</button>}
            {!!item.evidenceIds.length && <button type="button" onClick={() => showMatches(item.evidenceIds, item.matchedSourceIds)}
              className="rounded border px-2 py-1 font-medium text-gray-700 hover:bg-gray-50">View matches</button>}
          </div>}
          </div>}</details></li>; })}</ol>
      {queryChain?.loading && !queryChain.items.length && <p role="status">Loading search history…</p>}
      {!!queryChain?.error && <button type="button" onClick={() => void queryPages.fetchPage("queries", null, false)}
        className="w-full rounded py-1 text-sm font-medium text-red-700">Retry search history</button>}
      {queryChain?.nextCursor && <button type="button" disabled={queryChain.loading}
        onClick={() => void queryPages.fetchPage("queries", queryChain.nextCursor, true)}
        className="w-full rounded py-1 font-medium text-gray-600 hover:bg-gray-100 disabled:opacity-40">Load earlier searches</button>}
      </div>}</details>}
  </> : <p className="p-2 text-xs text-gray-500">Open or create a workspace to search saved sources.</p>;
  const selection = labelScope === "source" ? sourceSelected : highlightSelected,
    selectedLabel = selection?.size === 1 ? [...selection][0] : null;
  const filterCount = (sourceSelected?.size ?? 0) + (highlightFilter ? highlightSelected?.size ?? 0 : 0);

  const newWorkspace = () => setCreateOpen(true);
  const closeCreate = () => { setCreateOpen(false); if (returnToPicker.current) { returnToPicker.current = false; setOpen(true); } };
  const newFolder = () => { setFolderError(""); setFolderOpen(true); };
  const closeFolder = () => { setFolderOpen(false); if (returnToPicker.current) { returnToPicker.current = false; setOpen(true); } };
  const closeNote = () => { if (file && noteDraft !== file.state.note) void act({ type: "note", markdown: noteDraft }); setNoteOpen(false); };
  const removalMessage = (() => { if (!removing) return "";
    if (removing.kind === "source") { const count = file?.state.sources[removing.id]?.passages?.count ?? 0;
      return `Remove “${removing.name}” and ${count} saved passage${count === 1 ? "" : "s"} from this workspace?`; }
    if (removing.kind === "evidence") return `Delete the saved passage at ${removing.name}?`;
    const ids = expandSelection(new Set([removing.id]), children)!, prefix =
      `Delete “${removing.name}”${ids.size > 1 ? ` and ${ids.size - 1} nested label${ids.size === 2 ? "" : "s"}` : ""}?`;
    if (labels[removing.id]?.scope === "highlight")
      return `${prefix} Saved passages using these categories will lose them.`;
    const affected = allSources.filter((item) => item.labelIds.some((id) => ids.has(id))).length;
    return `${prefix} ${affected} saved source${affected === 1 ? "" : "s"} will lose ${ids.size === 1 ? "this label" : "these labels"}.`;
  })();
  const selector = file ? <div className="flex min-w-0 max-w-full items-center gap-2">
    <span className="min-w-0 truncate text-base font-semibold text-gray-900" title={fileTitle(file)}>{fileTitle(file)}</span>
    <ActionMenu label="Workspace options" className="shrink-0" items={[
    { label: "Rename", onSelect: () => setRenameOpen(true) },
    { label: "Workspace note", onSelect: () => setNoteOpen(true) },
    { label: "Open another", onSelect: () => setOpen(true) },
    { label: "New workspace", onSelect: () => { returnToPicker.current = false; newWorkspace(); } },
  ]} triggerClassName="grid size-8 place-items-center rounded-md border border-gray-300 bg-white text-gray-600 hover:bg-gray-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
    <Ellipsis className="size-4" aria-hidden="true" />
  </ActionMenu></div> : <span className="text-base font-semibold text-gray-900">Workspaces</span>;
  return <div ref={root} className="@container relative flex h-full min-h-0 flex-col overflow-hidden" onKeyDown={(event) => {
    const overlay = (event.target as Element).closest("dialog,[role='dialog'],[role='alertdialog'],[role='menu']");
    if (overlay && !overlay.contains(event.currentTarget)) return;
    if (event.key === "Escape" && !event.defaultPrevented && (labelsOpen || searchOpen)) {
      event.preventDefault(); event.stopPropagation(); if (labelsOpen) closeLabels(); else closeSearch(); }
  }}>
    {rail === undefined ? <div className="flex h-10 shrink-0 items-center pb-2">{selector}</div>
      : rail ? createPortal(selector, rail) : null}
    {status && <span role="status" className="pointer-events-none absolute bottom-2 left-1/2 z-30 max-w-[calc(100%-1rem)] -translate-x-1/2 truncate rounded-md border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-700 shadow-lg">{status}</span>}
    {!file ? <div className="rounded-xl border border-gray-200 bg-white/70 p-4">
      <div className="flex items-start gap-3"><FolderKanban className="mt-0.5 size-6 shrink-0 text-brand" aria-hidden="true" />
        <div className="min-w-0"><h2 className="text-base font-semibold text-gray-900">Workspace</h2>
        <p className="mt-0.5 text-sm leading-5 text-gray-600">Keep sources, passages, labels, searches, and notes together.</p>
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => setOpen(true)} className="h-9 rounded-md bg-gray-900 px-3 text-sm font-medium text-white hover:bg-gray-700">Open</button>
          <button type="button" onClick={() => { returnToPicker.current = false; newWorkspace(); }} className="h-9 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-800 hover:bg-gray-50">New workspace</button>
        </div></div>
      </div>
    </div> : <>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-gray-200 pb-3">
        <button ref={labelsButton} type="button" aria-expanded={labelsOpen} onClick={() => { setLabelsOpen(!labelsOpen); setSearchOpen(false); }}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium hover:bg-gray-50">
          <Tags className="size-4" aria-hidden="true" />Labels{filterCount > 0 ? ` (${filterCount})` : ""}
        </button>
        <button ref={searchButton} type="button" onClick={() => { setSearchOpen(true); setLabelsOpen(false); }}
          className="inline-flex h-9 items-center gap-2 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium hover:bg-gray-50">
          <Search className="size-4" aria-hidden="true" />Search Saved sources
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 gap-4 pt-3">
        {labelsOpen && <aside aria-label="Label organizer"
          className="absolute inset-0 z-20 flex min-h-0 flex-col overflow-y-auto bg-app-surface py-3 @[44rem]:static @[44rem]:w-64 @[44rem]:shrink-0 @[44rem]:border-e @[44rem]:border-gray-200 @[44rem]:pe-3">
          <div className="mb-3 flex items-center gap-2">
            <h2 className="flex-1 text-base font-semibold">Labels</h2>
            <button type="button" disabled={busy || !selectedLabel || !labels[selectedLabel]}
              onClick={() => selectedLabel && setRemoving({ kind: "label", id: selectedLabel, name: labels[selectedLabel].name })}
              aria-label={labelScope === "source" ? "Delete selected label" : "Delete selected highlight category"}
              className="grid size-8 place-items-center rounded hover:bg-gray-100 disabled:opacity-30"><Trash2 className="size-4" /></button>
            <button type="button" aria-label="Close labels" onClick={closeLabels}
              className="grid size-8 place-items-center rounded hover:bg-gray-100"><X className="size-4" /></button>
          </div>
          <div role="group" aria-label="Label scope" className="mb-3 grid grid-cols-2 gap-1 rounded-md bg-gray-100 p-1">
            {(["source", "highlight"] as const).map((scope) => <button key={scope} type="button" aria-pressed={labelScope === scope}
              onClick={() => setLabelScope(scope)} className={`h-8 rounded text-sm font-medium ${labelScope === scope ? "bg-white shadow-sm" : "text-gray-600"}`}>
              {scope === "source" ? "Sources" : "Passages"}</button>)}
          </div>
          {labelPanel(labelScope)}
        </aside>}
        <section aria-label="Saved sources" className={`min-w-0 flex-1 overflow-y-auto ${searchOpen ? "hidden" : labelsOpen ? "invisible @[44rem]:visible" : ""}`}>
          {matches && <div className="mb-3 flex items-center justify-between gap-2 text-sm"><span>Search matches</span>
            <button type="button" onClick={() => { setMatches(null); setSearchResult(null); }} className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-50">Clear search matches</button></div>}
          {searchResult && <div className="mb-3 space-y-2 text-sm text-gray-600">
            <p>{searchResult.coverage.complete ? "Search complete" : "Partial search"} · {searchResult.coverage.attempted_sources} of {searchResult.coverage.selected_sources} sources searched</p>
            {searchResult.coverage.next_after && <button type="button" disabled={busy}
              onClick={() => void query({ ...searchResult.input, after: searchResult.coverage.next_after! }, true)}
              className="h-9 rounded-md border border-gray-300 bg-white px-3 font-medium hover:bg-gray-50 disabled:opacity-40">{busy ? "Searching…" : "Continue search"}</button>}
          </div>}
          {listPanel()}
        </section>
        {searchOpen && <section aria-label="Search Saved sources" className="min-w-0 flex-1 overflow-y-auto">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold">Search Saved sources</h2>
            <button type="button" onClick={closeSearch} className="shrink-0 rounded-md border border-gray-300 px-2 py-1.5 text-sm font-medium hover:bg-gray-50">Back to sources</button>
          </div>
          {searchPanel()}
        </section>}
      </div>
    </>}
    <Modal open={ruleEditor !== null} onClose={closeRule} size="sm" className="!h-fit max-h-[calc(100dvh-2rem)] [&_.modal-scroll-body]:flex-none"
      breadcrumbs={["Search Saved sources", "Capture rule"]}
      cancelAction={{ label: "Done", onClick: closeRule }}
      primaryAction={{ label: "Run rules", onClick: () => { closeRule(); runQuery(); }, disabled: busy }}>
      {ruleEditor !== null && recipe.rules[ruleEditor] && <div className="grid grid-cols-2 gap-3 pb-5 text-[13px]">
        <label className="col-span-2 grid gap-1 text-gray-600">Phrase to find
          <input autoFocus value={recipe.rules[ruleEditor].phrase} onChange={(event) => editRule({ phrase: event.target.value })}
            className="h-9 rounded border border-gray-300 px-2 text-sm text-gray-900" />
        </label>
        <label className="grid gap-1 text-gray-600">Direction
          <ChoiceMenu label="Direction" value={recipe.rules[ruleEditor].direction} onChange={(direction) => editRule({ direction: direction as Rule["direction"] })}
            options={[{ value: "after", label: "After phrase" }, { value: "before", label: "Before phrase" }]} />
        </label>
        <label className="grid gap-1 text-gray-600">Unit
          <ChoiceMenu label="Unit" value={recipe.rules[ruleEditor].unit} onChange={(unit) => editRule({ unit: unit as Rule["unit"] })}
            options={[{ value: "sentence", label: "Sentence" }, { value: "line", label: "Line" }, { value: "paragraph", label: "Paragraph" }, { value: "chars", label: "Characters" }]} />
        </label>
        <label className="grid gap-1 text-gray-600">Save as highlight
          <ChoiceMenu label="Save as highlight" value={recipe.rules[ruleEditor].slot} onChange={(slot) => editRule({ slot })}
            options={[{ value: UNCLASSIFIED, label: "Unclassified" },
              ...Object.values(labels).filter(({ scope }) => scope === "highlight").sort((a, b) => a.order - b.order)
                .map((label) => ({ value: label.id, label: label.name }))]} />
        </label>
        {recipe.rules[ruleEditor].unit === "chars" && <label className="grid gap-1 text-gray-600">Characters
          <input type="number" min="10" max="50000" value={recipe.rules[ruleEditor].chars ?? 100}
            onChange={(event) => editRule({ chars: Number(event.target.value) })} className="h-9 rounded border px-2 text-sm text-gray-900" />
        </label>}
      </div>}
    </Modal>
    <Modal open={open} onClose={() => setOpen(false)} size="lg" className="!h-[min(30rem,calc(100dvh-2rem))]" breadcrumbs={["Library", "Workspaces"]}
      cancelAction={{ label: "Close", onClick: () => setOpen(false) }} primaryAction={{ label: busy ? "Opening..." : "Open",
        onClick: () => { const document = selectedDocuments.find(isResearchDocument); if (document) void choose(() => getResearchFile(document.id)); },
        disabled: busy || !selectedDocuments.some(isResearchDocument) }}>
      <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <button type="button" onClick={() => { returnToPicker.current = true; setOpen(false); newWorkspace(); }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-gray-900 px-2.5 text-sm font-medium text-white hover:bg-gray-700"><Plus className="size-3.5" />New workspace</button>
        <button type="button" disabled={!projectId && "projectId" in openLocation && !openLocation.projectId}
          onClick={() => { returnToPicker.current = true; setOpen(false); newFolder(); }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"><FolderPlus className="size-3.5" />New folder</button>
        <button type="button" onClick={() => { returnToPicker.current = true; setOpen(false); setProjectOpen(true); }}
          className="inline-flex h-8 items-center gap-1.5 rounded-md border border-gray-300 bg-white px-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50"><FolderKanban className="size-3.5" />New project</button>
      </div>
      <FileDirectory key={directoryKey} selectedDocuments={selectedDocuments} onChange={(items) => setSelectedDocuments(items.slice(-1))}
        showTabs={!projectId} projectId={projectId} initialTab={projectId ? "projects" : "files"}
        tabs={[["files", "Library"], ["projects", "Projects"]]} noun="workspaces" multiple={false}
        documentFilter={isResearchDocument} onLocationChange={setOpenLocation} />
      </div>
    </Modal>
    <Modal open={createOpen} onClose={closeCreate} size="sm" breadcrumbs={["Workspaces", "New workspace"]}
      className="!h-fit [&_.modal-scroll-body]:flex-none" cancelAction={{ label: "Cancel", onClick: closeCreate }}
      primaryAction={{ label: busy ? "Creating..." : "Create workspace", type: "submit", form: "research-create",
        disabled: busy || ("projectId" in openLocation && !openLocation.projectId) }}>
      <form id="research-create" onSubmit={create} className="space-y-3 pb-5">
        <label className="grid gap-1 text-xs font-medium text-gray-700">Workspace name
          <input required autoFocus name="title" placeholder="e.g. Duty of care" className="h-9 rounded-md border border-gray-300 px-2 text-sm font-normal text-gray-900" />
        </label>
        <div role="group" aria-label="Workspace location" className="grid grid-cols-2 rounded-md bg-gray-100 p-1 text-sm font-medium">
          {(["Library", "Project"] as const).map((label) => { const selected = label === "Project" ? "projectId" in openLocation : "library" in openLocation;
            return <button key={label} type="button" aria-pressed={selected} onClick={() => { setCreateFolder(null); setOpenLocation(label === "Project"
              ? { projectId: null } : { library: "files" }); }} className={`h-8 rounded ${selected ? "bg-white text-gray-900 shadow-sm" : "text-gray-600 hover:text-gray-900"}`}>{label}</button>; })}
        </div>
        {"projectId" in openLocation && !openLocation.projectId ? <ProjectChoiceList value={null}
          onChange={(selectedProject) => setOpenLocation({ projectId: selectedProject })} />
          : <div className="h-40"><FolderBrowser key={createProjectId ?? "library"} list={createDirectory.list} createFolder={createDirectory.createFolder}
            rootLabel={createProjectId ? "Project" : "Library"} hideRoot={!createProjectId} onSelect={setCreateFolder}
            onBack={createProjectId ? () => { setCreateFolder(null); setOpenLocation({ projectId: null }); } : undefined} /></div>}
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
    <Modal open={noteOpen} onClose={closeNote} size="sm" className="!h-fit [&_.modal-scroll-body]:flex-none"
      breadcrumbs={["Workspace", "Note"]} cancelAction={{ label: "Done", onClick: closeNote }}>
      <textarea autoFocus value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} aria-label="Workspace note"
        placeholder="Notes about this workspace" className="mb-5 min-h-40 w-full resize-y rounded-md border border-gray-300 p-2 text-sm leading-5" />
    </Modal>
    <Modal open={folderOpen} onClose={closeFolder} size="sm" className="!h-fit [&_.modal-scroll-body]:flex-none"
      breadcrumbs={["projectId" in openLocation ? "Projects" : "Library", "New folder"]}
      cancelAction={{ label: "Cancel", onClick: closeFolder }}
      primaryAction={{ label: busy ? "Creating..." : "Create folder", type: "submit", form: "research-new-folder",
        disabled: busy }}>
      <form id="research-new-folder" onSubmit={createLibraryFolder} className="pb-5">
        <label className="grid gap-1 text-xs font-medium text-gray-600">Folder name
          <input required autoFocus name="name" className="h-9 rounded-md border border-gray-300 px-2 text-sm font-normal text-gray-900" />
        </label>
        {folderError && <p role="alert" className="mt-2 text-xs text-red-700">{folderError}</p>}
      </form>
    </Modal>
    <NewProjectModal open={projectOpen} onClose={() => { setProjectOpen(false); if (returnToPicker.current) {
      returnToPicker.current = false; setOpen(true); } }} onCreated={() => {
      setDirectoryKey((value) => value + 1); setProjectOpen(false); setOpen(true); returnToPicker.current = false; }} />
    <ConfirmPopup open={!!removing} title={removing?.kind === "label" ? "Delete label?" : removing?.kind === "source" ? "Remove source?" : "Delete passage?"}
      message={removalMessage} confirmLabel={removing?.kind === "source" ? "Remove" : "Delete"}
      onCancel={() => setRemoving(null)} onConfirm={() => { if (removing) void act(removing.kind === "evidence"
        ? { type: "remove", kind: "evidence", id: removing.id, sourceId: removing.sourceId! }
        : { type: "remove", kind: removing.kind, id: removing.id }); setRemoving(null); }} />
  </div>;
}
