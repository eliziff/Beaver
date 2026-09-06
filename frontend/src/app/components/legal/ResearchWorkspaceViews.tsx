import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createChat, getChat, getChatResearchAnswers } from "@/app/lib/api/chat";
import { createTabularReview, getTabularReview, type TabularCell, type ColumnConfig } from "@/app/lib/api/tabular";
import { researchSourceKey, type ResearchFile, type ResearchSelection } from "@/app/lib/researchFiles";
import { getResearchFile } from "@/app/lib/api/researchFiles";
import { errorMessage } from "@/app/lib/utils";
import type { Citation } from "@/app/lib/citations";
import { ResearchViews } from "../shared/ResearchViews";
import { SearchableChoiceModal } from "../modals/ModalSelect";
import { GroundedAnswerContent } from "../shared/GroundedAnswerContent";

const fulfilled = <T,>(results: PromiseSettledResult<T>[]) => results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);

export function ResearchWorkspaceViews({ file, selection, onChange }: {
  file: ResearchFile; selection: ResearchSelection; onChange: (file: ResearchFile) => void;
}) {
  const navigate = useNavigate();
  const [choices, setChoices] = useState<{ kind: "Table" | "Chat"; items: { value: string; label: string }[] } | null>(null);
  const [error, setError] = useState("");
  const emptySelection = selection.sourceIds?.length === 0 || selection.target === "passages" &&
    (selection.evidenceIds?.length === 0 || selection.labelIds?.length === 0 && !selection.unlabelled);
  const openChat = (id: string) => navigate(`${file.document.project_id ? `/projects/${file.document.project_id}` : ""}/assistant/chat/${id}`);
  const create = async () => { const chat = await createChat({ research_file_id: file.document.id,
    ...(file.document.project_id ? { project_id: file.document.project_id } : {}) }); openChat(chat.id); };
  const createTable = async () => {
    if (emptySelection) throw new Error(`No ${selection.target} selected`);
    const review = await createTabularReview({ title: file.document.filename.replace(/\.research\.md$/iu, ""),
      project_id: file.document.project_id ?? undefined, columns_config: [],
      research_file_id: file.document.id, research_selection: selection });
    onChange(await getResearchFile(file.document.id));
    navigate(`/tabular-reviews/${encodeURIComponent(review.id)}?chat=new`, { state: {
      tableIntent: "Arrange the selected research in this table. Reuse its labels, passages and answers; choose useful rows, columns and grouping for the existing organization.",
    } });
  };
  return <>
    <ResearchViews table={async () => {
      const results = await Promise.allSettled((file.state.tables ?? []).map(getTabularReview)), tables = fulfilled(results);
      setError(tables.length < results.length ? "Some saved tables are unavailable." : "");
      if (!results.length) await createTable();
      else setChoices({ kind: "Table", items: tables.map(({ review }) => ({ value: review.id, label: review.title || "Untitled review" })) });
    }} chat={async () => {
      const results = await Promise.allSettled((file.state.chats ?? []).map((id) => getChat(id))), chats = fulfilled(results);
      setError(chats.length < results.length ? "Some saved chats are unavailable." : "");
      if (!results.length) await create();
      else setChoices({ kind: "Chat", items: chats.map(({ chat }) => ({ value: chat.id, label: chat.title || "Untitled chat" })) });
    }} />
    <SearchableChoiceModal open={!!choices} onClose={() => { setChoices(null); setError(""); }} title={`Open ${choices?.kind.toLowerCase() ?? "view"}`}
      value={null} options={[...(choices?.items ?? []), { value: "new", label: choices?.kind === "Table" ? "New table" : "New chat", disabled: choices?.kind === "Table" && emptySelection }]}
      footer={error && <p role="alert" className="text-sm text-red-700">{error}</p>} closeOnSelect={false}
      onChange={(id) => {
        if (!id) return;
        if (choices?.kind === "Table") {
          if (id === "new") void createTable().then(() => setChoices(null)).catch((reason) => setError(errorMessage(reason, "Could not create table")));
          else { navigate(`/tabular-reviews/${encodeURIComponent(id)}`); setChoices(null); }
        }
        else if (id === "new") void create().then(() => setChoices(null)).catch((reason) => setError(errorMessage(reason, "Could not create chat")));
        else { openChat(id); setChoices(null); }
      }} />
  </>;
}

type Finding = { id: string; source: string; column: ColumnConfig; content: NonNullable<TabularCell["content"]> };
export function useResearchAnswers(file: ResearchFile | null) {
  const [findings, setFindings] = useState<Finding[]>([]), [error, setError] = useState("");
  const tables = JSON.stringify(file?.state.tables ?? []), chats = JSON.stringify(file?.state.chats ?? []);
  useEffect(() => {
    if (!file || tables === "[]" && chats === "[]") { setFindings([]); setError(""); return; }
    let live = true, generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const current = ++generation;
      try {
        const tableResults = await Promise.allSettled((JSON.parse(tables) as string[]).map(getTabularReview)), details = fulfilled(tableResults);
        const chatResults = await Promise.allSettled((JSON.parse(chats) as string[]).map(async (id) => {
          const result: Finding[] = []; let offset: number | null = 0;
          while (offset !== null && live) { const page = await getChatResearchAnswers(id, file.document.id, offset);
            for (const item of page.items) if (item.kind === "answer") result.push({ id: `${id}:${item.question.id}:${item.resource}`,
              source: item.resource, column: { index: 0, name: item.question.title, prompt: item.question.prompt },
              content: { ...item.answer, evidence: item.evidence, summary: "", outcome: "answered", coverage: "complete" } });
            offset = page.next_offset;
          } return result;
        })), answers = fulfilled(chatResults).flat();
        for (const detail of details) for (const cell of detail.cells) {
          const doc = detail.documents.find(({ id }) => id === cell.document_id), column = detail.review.columns_config?.find(({ index }) => index === cell.column_index);
          if (cell.content && column && doc?.reference) answers.push({ id: cell.id, source: researchSourceKey(doc.reference), column, content: cell.content });
        }
        if (live && current === generation) { setFindings(answers);
          setError([...tableResults, ...chatResults].some(({ status }) => status === "rejected") ? "Some saved answers are unavailable." : "");
          if (details.some(({ review }) => review.is_running)) timer = setTimeout(load, 2000); }
      } catch (reason) { if (live && current === generation) setError(errorMessage(reason, "Could not load saved answers")); }
    };
    const refresh = () => { clearTimeout(timer); void load(); };
    refresh(); window.addEventListener("focus", refresh);
    return () => { live = false; clearTimeout(timer); window.removeEventListener("focus", refresh); };
  }, [file?.document.id, file?.versionId, file?.workingRevision, tables, chats]);
  return { findings, error };
}
export function ResearchSourceAnswers({ findings, onCitation }: { findings: Finding[]; onCitation: (citation: Citation) => void }) {
  return findings.map(({ id, column, content }) => <details key={id} className="border-s-2 border-gray-200 ps-2">
      <summary className="cursor-pointer text-sm font-medium text-gray-800">{column.name}</summary>
      <GroundedAnswerContent answer={content} column={column} onCitation={onCitation} />
    </details>);
}
