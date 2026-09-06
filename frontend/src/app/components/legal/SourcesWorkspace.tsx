import { createContext, useCallback, useContext, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { bindWorkspaceView, ensureSourcesWorkspace, getResearchFile, getResearchItems, getWorkspaceFindings,
  getWorkspaceViews, openWorkspaceTable, type ResearchFinding } from "@/app/lib/api/researchFiles";
import { createChat } from "@/app/lib/api/chat";
import { BeaverApiError } from "@/app/lib/api/client";
import type { ResearchFile, ResearchPageItem, ResearchSelection } from "@/app/lib/researchFiles";
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

  return { file, selection, setSelection, accept, open, refresh, loading, error, mutations, passages, findings,
    ensure, bind, table, chat, views: () => getWorkspaceViews(requireFile().document.id), retry: restore };
}

export function SourcesWorkspaceProvider(props: Options) {
  const controller = useWorkspaceController(props);
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
