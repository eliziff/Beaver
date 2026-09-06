import { createContext, useCallback, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { bindWorkspaceView, ensureSourcesWorkspace, getResearchFile, getResearchItems, getWorkspaceFindings,
  getWorkspaceViews, openWorkspaceTable, type ResearchFinding } from "@/app/lib/api/researchFiles";
import { createChat } from "@/app/lib/api/chat";
import { BeaverApiError } from "@/app/lib/api/client";
import { researchSourceKey, type PassageLocator, type ResearchFile, type ResearchPageItem,
  type ResearchSelection, type ResearchSourceReference } from "@/app/lib/researchFiles";
import { usePagedChains } from "@/app/hooks/usePagedChains";
import { errorMessage } from "@/app/lib/utils";
import { useResearchFileMutations } from "./useResearchFileMutations";

type Options = {
  children: ReactNode;
  fileId?: string | null;
  file?: ResearchFile | null;
  projectId?: string;
  refreshKey?: string | null;
  selection?: ResearchSelection | null;
  restoreLast?: boolean;
  onChange?: (file: ResearchFile | null) => void;
};
type Controller = ReturnType<typeof useWorkspaceController>;
const Context = createContext<Controller | null>(null);
const ALL_SOURCES: ResearchSelection = { target: "sources" };
const PEN_KEY = "beaver.research.pen.v1";
/** What a reader hands the Highlight tool: the source it shows and the text the user picked. */
export type HighlightCapture = { reference: ResearchSourceReference; locator: PassageLocator; quote: string };

function useWorkspaceController({ fileId, file: supplied, projectId, refreshKey, selection: suppliedSelection, restoreLast = false, onChange }: Options) {
  const memoryKey = `beaver.research.current:${projectId ?? "personal"}`;
  const [file, setFile] = useState<ResearchFile | null>(supplied ?? null);
  const current = useRef(file), generation = useRef(0);
  const [selection, setSelection] = useState<ResearchSelection>(suppliedSelection ?? ALL_SOURCES);
  const requested = useRef({ fileId, selection: suppliedSelection });
  requested.current = { fileId, selection: suppliedSelection };
  const [loading, setLoading] = useState(!supplied && !!(fileId || restoreLast && localStorage.getItem(memoryKey)));
  const [error, setError] = useState("");
  const changed = useEffectEvent((next: ResearchFile | null) => onChange?.(next));
  const accept = useCallback((next: ResearchFile | null) => {
    if (current.current?.document.id !== next?.document.id) {
      generation.current++;
      setSelection(next?.document.id === requested.current.fileId ? requested.current.selection ?? ALL_SOURCES : ALL_SOURCES);
    }
    current.current = next;
    setFile(next);
    setError("");
  }, []);
  const mutations = useResearchFileMutations(file, accept);
  const sources = file?.state.sources ?? {};
  const passages = usePagedChains<ResearchPageItem>((sourceId, cursor, signal) => getResearchItems(file!.document.id,
    { kind: "passages", sourceId, cursor, limit: 50 }, signal), [file?.document.id], "passages", false,
    Object.fromEntries(Object.values(sources).map((source) => [source.id, source.passages?.sha256 ?? ""])));
  const [running, setRunning] = useState(false);
  const [findingsRevision, setFindingsRevision] = useState(0);
  const findings = usePagedChains<ResearchFinding>(async (sourceId, cursor, signal) => {
    const page = await getWorkspaceFindings(file!.document.id, { sourceIds: [sourceId], offset: Number(cursor ?? 0) }, signal);
    if (!signal.aborted) setRunning(page.is_running === true);
    return { items: page.items, next_cursor: page.next_offset === null ? null : String(page.next_offset) };
  }, [file?.document.id], "findings", false,
    Object.fromEntries(Object.keys(sources).map((id) => [id, `${file?.versionId}:${file?.workingRevision}:${findingsRevision}`])));
  useEffect(() => {
    if (file) localStorage.setItem(memoryKey, file.document.id);
    changed(file);
  }, [file, memoryKey]);
  useEffect(() => { if (supplied !== undefined) accept(supplied); }, [supplied, accept]);
  const selectionKey = JSON.stringify(suppliedSelection ?? ALL_SOURCES);
  useEffect(() => { setSelection(JSON.parse(selectionKey) as ResearchSelection); }, [selectionKey]);

  const open = useCallback(async (id: string) => {
    const run = ++generation.current;
    setLoading(true); setError("");
    try {
      const next = await getResearchFile(id);
      if (run === generation.current) { accept(next); setLoading(false); }
      return next;
    } catch (reason) {
      if (run === generation.current) { setError(errorMessage(reason, "Could not open workspace")); setLoading(false); }
      throw reason;
    }
  }, [accept]);
  const refresh = useCallback(async () => {
    const previous = current.current, run = generation.current;
    if (!previous) return;
    const next = await getResearchFile(previous.document.id);
    if (run === generation.current && current.current === previous) { accept(next); setFindingsRevision((value) => value + 1); }
  }, [accept]);
  const restore = useCallback(async () => {
    const id = fileId ?? (restoreLast ? localStorage.getItem(memoryKey) : null);
    if (!id || supplied) { setLoading(false); return; }
    try { await open(id); }
    catch (reason) {
      if (!fileId && reason instanceof BeaverApiError && reason.status === 404) {
        if (localStorage.getItem(memoryKey) === id) localStorage.removeItem(memoryKey);
        setError("");
      }
    }
  }, [fileId, restoreLast, memoryKey, supplied, open]);
  const previousId = useRef(fileId);
  useEffect(() => {
    if (previousId.current !== fileId && !supplied) accept(null);
    previousId.current = fileId;
    void restore();
    return () => { generation.current++; };
  }, [fileId, memoryKey, restoreLast, restore, accept, supplied]);
  useEffect(() => {
    const focused = () => { void refresh().catch(() => undefined); };
    window.addEventListener("focus", focused);
    return () => window.removeEventListener("focus", focused);
  }, [refresh]);
  const after = useRef(refreshKey);
  useEffect(() => {
    const changed = after.current !== refreshKey; after.current = refreshKey;
    if (changed && refreshKey) void refresh().catch(() => undefined);
  }, [refreshKey, refresh]);
  useEffect(() => {
    if (!running) return;
    const timer = window.setTimeout(() => {
      for (const id of Object.keys(findings.chains)) void findings.fetchPage(id, null, false);
    }, 2000);
    return () => window.clearTimeout(timer);
  }, [running, findings.chains, findings.fetchPage]);

  const requireFile = () => {
    if (!current.current) throw new Error("Open a workspace first");
    return current.current;
  };
  async function ensure(input: Parameters<typeof ensureSourcesWorkspace>[0]) {
    const next = await ensureSourcesWorkspace(input); accept(next); return next;
  }
  async function bind(id: string, input: Parameters<typeof bindWorkspaceView>[1]) {
    const next = await bindWorkspaceView(id, input); accept(next); return next;
  }
  async function table(input: Parameters<typeof openWorkspaceTable>[1] = {}) {
    const result = await openWorkspaceTable(requireFile().document.id, { selection, ...input });
    await refresh(); return result;
  }
  async function chat(id?: string) {
    const source = requireFile();
    if (id) await bind(source.document.id, { chatId: id, selection });
    else { const next = await createChat({ research_file_id: source.document.id, research_selection: selection,
      ...(source.document.project_id ? { project_id: source.document.project_id } : {}) }); id = next.id; await refresh(); }
    return { id, path: `${source.document.project_id ? `/projects/${source.document.project_id}` : ""}/assistant/chat/${id}` };
  }

  const [pen, setPenState] = useState<string | null>(null), [armed, setArmed] = useState(false);
  const capture = useRef<(() => HighlightCapture | null) | null>(null);
  const penFile = useRef(file?.document.id); penFile.current = file?.document.id;
  const penId = useRef(pen); penId.current = pen;
  const openedId = file?.document.id;
  useEffect(() => { setPenState(openedId ? localStorage.getItem(`${PEN_KEY}:${openedId}`) : null); }, [openedId]);
  const setPen = useCallback((id: string | null) => {
    setPenState(id); const key = penFile.current; if (!key) return;
    if (id) localStorage.setItem(`${PEN_KEY}:${key}`, id); else localStorage.removeItem(`${PEN_KEY}:${key}`);
  }, []);
  const { act } = mutations;
  /** One deliberate write: prepare the source, ensure a pen, save the passage with it. */
  const runHighlight = useCallback(async (): Promise<"saved" | "armed" | "none"> => {
    if (!capture.current) return "none";
    const picked = capture.current();
    if (!picked) { setArmed(true); return "armed"; }
    const base = current.current;
    if (!base) throw new Error("Open a workspace first");
    const key = researchSourceKey(picked.reference);
    const sourceId = Object.values(base.state.sources).find(({ reference }) =>
      researchSourceKey(reference) === key)?.id ?? (await act({ type: "source", reference: picked.reference })).sourceId;
    if (!sourceId) throw new Error("Saved source was not returned");
    const labels = current.current?.state.labels ?? {};
    let active = penId.current && labels[penId.current]?.scope === "highlight" ? penId.current
      : Object.values(labels).filter(({ scope }) => scope === "highlight").sort((a, b) => a.order - b.order)[0]?.id;
    if (!active) {
      active = crypto.randomUUID();
      await act({ type: "label", id: active, name: "Highlight", parentId: null, scope: "highlight", color: "#eab308" });
    }
    if (active !== penId.current) { penId.current = active; setPen(active); }
    await act({ type: "passage", sourceId, locator: picked.locator, quote: picked.quote, labelIds: [active] });
    window.getSelection()?.removeAllRanges();
    setArmed(false);
    return "saved";
  }, [act, setPen]);
  const highlight = { pen, setPen, armed, arm: setArmed, run: runHighlight,
    registerReader: useCallback((next: (() => HighlightCapture | null) | null) => { capture.current = next; }, []) };

  return { file, selection, setSelection, accept, open, refresh, loading, error, mutations, passages, findings,
    ensure, bind, table, chat, highlight, views: () => getWorkspaceViews(requireFile().document.id), retry: restore };
}

export function SourcesWorkspaceProvider(props: Options) {
  const nested = !!useContext(Context);
  const controller = useWorkspaceController(props);
  const { run } = controller.highlight;
  useEffect(() => {
    if (nested) return;
    const pressed = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.key.toLowerCase() !== "h") return;
      event.preventDefault();
      void run().catch(() => undefined);
    };
    document.addEventListener("keydown", pressed);
    return () => document.removeEventListener("keydown", pressed);
  }, [nested, run]);
  return <Context value={controller}>{props.children}</Context>;
}

/** Readers and view panels share their host's workspace and mutation lane. */
export function SourcesWorkspace(props: Options) {
  const parent = useContext(Context);
  return parent ? props.children : <SourcesWorkspaceProvider {...props} />;
}

export function useSourcesWorkspace() {
  const workspace = useContext(Context);
  if (!workspace) throw new Error("Sources workspace context is missing");
  return workspace;
}

/** Null outside a SourcesWorkspace; readers use it to offer workspace tools only when hosted. */
export function useSourcesWorkspaceOrNull() {
  return useContext(Context);
}
