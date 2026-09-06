import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Citation } from "@/app/lib/citations";
import type { Message } from "@/app/lib/api/chat";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { errorMessage } from "@/app/lib/utils";
import { ResearchViews } from "../shared/ResearchViews";
import { SearchableChoiceModal } from "../modals/ModalSelect";
import { GroundedAnswerContent } from "../shared/GroundedAnswerContent";
import { Button } from "../ui/button";
import { workspaceTableRoute } from "../tabular/tabularReviewRoute";
import { useSourcesWorkspace } from "./SourcesWorkspace";
import { OrganizeComposer, type OrganizeTarget } from "./OrganizeComposer";

type Run = { chatId: string; path: string; message: Message };
/** Runs one visible organization turn in the bound chat without leaving the workspace. */
function OrganizeRun({ run, target, onDone }: { run: Run; target: OrganizeTarget; onDone: () => void }) {
  const workspace = useSourcesWorkspace();
  const assistant = useAssistantChat({ chatId: run.chatId, stayInPlace: true,
    projectId: workspace.file?.document.project_id ?? undefined });
  const submitted = useRef(false), started = useRef(false);
  const { handleChat, cancel } = assistant.actions, loaded = assistant.chatLoad.status === "loaded", running = !!assistant.state.run;
  useEffect(() => {
    if (submitted.current || !loaded) return;
    submitted.current = true;
    void handleChat(run.message).catch(() => undefined);
  }, [loaded, handleChat, run.message]);
  useEffect(() => {
    if (running) started.current = true;
    else if (started.current) onDone();
  }, [running, onDone]);
  return <OrganizeComposer target={target} running onRun={async () => undefined} chatHref={run.path}
    onCancel={() => { cancel(); onDone(); }} />;
}

/** The single place a workspace asks the assistant to (re)organize its labels; runs stay visible until done. */
export function WorkspaceOrganize({ open, onClose, target = "labels" }: { open: boolean; onClose: () => void; target?: OrganizeTarget }) {
  const workspace = useSourcesWorkspace();
  const [run, setRun] = useState<Run | null>(null);
  async function start(content: string) {
    const file = workspace.file;
    if (!file) throw new Error("Open a workspace first");
    const views = await workspace.views(), chat = await workspace.chat(views.chats[0]?.id);
    setRun({ chatId: chat.id, path: chat.path,
      message: { role: "user", content, research_file_id: file.document.id, research_selection: workspace.selection } });
    onClose();
  }
  if (run) return <OrganizeRun run={run} target={target}
    onDone={() => { setRun(null); void workspace.refresh().catch(() => undefined); }} />;
  return open ? <OrganizeComposer target={target} onRun={start} onClose={onClose} /> : null;
}

export function ResearchWorkspaceViews() {
  const workspace = useSourcesWorkspace(), navigate = useNavigate();
  const [choices, setChoices] = useState<{ kind: "Table" | "Chat"; items: { value: string; label: string }[] } | null>(null);
  const [error, setError] = useState("");
  async function open(kind: "Table" | "Chat", id?: string) {
    if (kind === "Chat") navigate((await workspace.chat(id)).path);
    else navigate(workspaceTableRoute(await workspace.table(id ? { tableId: id } : {})));
  }
  async function choose(kind: "Table" | "Chat") {
    const views = await workspace.views(), items = kind === "Table" ? views.tables : views.chats;
    if (!items.length) return open(kind);
    setError("");
    setChoices({ kind, items: items.map(({ id, title }) => ({ value: id, label: title || `Untitled ${kind.toLowerCase()}` })) });
  }
  return <>
    <ResearchViews table={() => choose("Table")} chat={() => choose("Chat")} />
    <SearchableChoiceModal open={!!choices} onClose={() => setChoices(null)} title={`Open ${choices?.kind.toLowerCase() ?? "view"}`}
      value={null} options={[...(choices?.items ?? []), { value: "new", label: `New ${choices?.kind.toLowerCase() ?? "view"}` }]}
      footer={error && <p role="alert" className="text-sm text-red-700">{error}</p>} closeOnSelect={false}
      onChange={(id) => { if (id && choices) void open(choices.kind, id === "new" ? undefined : id)
        .then(() => setChoices(null)).catch((reason) => setError(errorMessage(reason, "Could not open view"))); }} />
  </>;
}

export function ResearchSourceAnswers({ sourceId, onCitation }: { sourceId: string; onCitation: (citation: Citation) => void }) {
  const { findings } = useSourcesWorkspace(), page = findings.chains[sourceId];
  useEffect(() => { if (!page) void findings.fetchPage(sourceId, null, false); }, [page, sourceId, findings.fetchPage]);
  return <>
    {page?.items.map(({ reference, question, answer, evidence }) => <details key={JSON.stringify(reference)} className="border-s-2 border-gray-200 ps-3">
      <summary className="cursor-pointer text-sm font-medium text-gray-900">{question.title}</summary>
      <div className="pt-2"><GroundedAnswerContent answer={{ ...answer, evidence }} column={question} onCitation={onCitation} /></div>
    </details>)}
    {page?.loading && !page.items.length && <p role="status" className="text-sm text-gray-500">Loading answers…</p>}
    {!!page?.error && <Button size="compact" variant="outline" onClick={() => void findings.fetchPage(sourceId, null, false)}>Retry answers</Button>}
    {page?.nextCursor && <Button size="compact" variant="outline" disabled={page.loading}
      onClick={() => void findings.fetchPage(sourceId, page.nextCursor, true)}>More answers</Button>}
  </>;
}
