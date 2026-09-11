import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { applyWorkspaceLabels, getResearchFile, openWorkspaceTable, previewWorkspaceLabels, previewWorkspaceTable,
    type ResearchLabelProposal, type ResearchTablePreview, type ResearchTableInput } from "@/app/lib/api/researchFiles";
import { isResearchDocument, type ResearchFile, type ResearchSelection } from "@/app/lib/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import { errorMessage } from "@/app/lib/utils";
import { Button } from "../ui/button";
import { Modal } from "../modals/Modal";
import { FileDirectory } from "../shared/FileDirectory";
import { tabularReviewPath } from "./tabularReviewRoute";
import { useSelectedModel, useSelectedReasoningEffort } from "@/app/hooks/useSelectedModel";

const HEAD = "text-sm font-semibold text-gray-900", META = "text-xs text-gray-500";
const CARD = "relative min-w-0 break-words rounded-lg border border-gray-200 p-4 pe-10";
const FIELD = "block w-full min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-gray-200 focus:border-gray-300";
const INPUT = "w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900";
type Props = { open: boolean; onClose: () => void; fileId?: string; projectId?: string | null; mode?: "table" | "labels";
    selection?: ResearchSelection; chatId?: string; tableId?: string; columnIndex?: number; defaultRequest?: string; onOpen: (path: string) => void;
    /** The model that produced the research; the picker's current choice is only the fallback. */
    model?: string | null; reasoningEffort?: string | null };
type Design = ResearchTablePreview["design"];
export const ImportResearchSet = ({ open, ...props }: Props) => open ? <OpenImportResearchSet {...props} /> : null;
/** One organizing step in either direction: the model proposes the structure from the research; the user edits it before it exists. */
function OpenImportResearchSet({ onClose, fileId, projectId, selection, chatId, tableId, columnIndex, onOpen,
    mode = "table", defaultRequest = "", model: chatModel, reasoningEffort: chatEffort }: Omit<Props, "open">) {
    const labelling = mode === "labels";
    const [picked, setPicked] = useState<Document[]>([]), [file, setFile] = useState<ResearchFile | null>(null);
    const [preview, setPreview] = useState<ResearchTablePreview | null>(null), [plan, setPlan] = useState<ResearchLabelProposal | null>(null);
    const [adjust, setAdjust] = useState(""), [addition, setAddition] = useState(""), [name, setProposedName] = useState("");
    const [busy, setBusy] = useState(false), [creating, setCreating] = useState(false);
    const [error, setError] = useState(""), [note, setNote] = useState("");
    const generation = useRef(0), activeId = fileId ?? picked[0]?.id, [pickerModel] = useSelectedModel(), [pickerEffort] = useSelectedReasoningEffort();
    // The chat's own model first; if its provider fails, one retry on the picker's model.
    const [lane, setLane] = useState<"chat" | "picker">(chatModel ? "chat" : "picker");
    // Accept the proposal on the reading that produced it: a redesign is not re-filed under the existing ontology.
    const [redesigned, setRedesigned] = useState(false);
    const model = lane === "chat" && chatModel ? chatModel : pickerModel, effort = lane === "chat" && chatModel ? chatEffort ?? undefined : pickerEffort;
    const input: ResearchTableInput = { ...(selection ? { selection } : {}), ...(chatId ? { chatId } : {}), ...(tableId ? { tableId, columnIndex } : {}) };
    const inputKey = JSON.stringify(input);
    async function propose(instruction = "", repropose = false) {
        if (!activeId) return;
        const run = ++generation.current; setBusy(true); setError(""); setNote("");
        try {
            const request = [defaultRequest.trim(), instruction.trim()].filter(Boolean).join("\n");
            const body = { ...JSON.parse(inputKey) as ResearchTableInput, ...(request ? { request } : {}), ...(repropose ? { repropose } : {}), model,
                ...(effort ? { reasoningEffort: effort } : {}) };
            const [current, next] = await Promise.all([getResearchFile(activeId),
                labelling ? previewWorkspaceLabels(activeId, body) : previewWorkspaceTable(activeId, body)]);
            if (run !== generation.current) return;
            setFile(current); setRedesigned(repropose);
            if (labelling) { setPlan(next as ResearchLabelProposal); setProposedName((next as ResearchLabelProposal).title); }
            else { setPreview(next as ResearchTablePreview); setNote((next as ResearchTablePreview).fallback ?? ""); }
        } catch (reason) { if (run !== generation.current) return;
            if (lane === "chat" && chatModel && pickerModel && pickerModel !== chatModel) { setLane("picker"); return; }
            setError(errorMessage(reason, labelling
            ? "Could not propose labels; nothing was changed" : "Could not propose a table; nothing was changed")); }
        finally { if (run === generation.current) setBusy(false); }
    }
    useEffect(() => { setPreview(null); setPlan(null); void propose(); return () => { generation.current++; }; },
        [activeId, inputKey, labelling, lane]); // eslint-disable-line react-hooks/exhaustive-deps
    const columns = preview?.design.columns ?? [];
    const valid = labelling ? !!plan : columns.length > 0 && columns.every((column) => column.name.trim() && column.prompt.trim());
    async function create() {
        if (!activeId || creating || busy || !valid) return;
        setCreating(true); setError("");
        try {
            if (labelling) { await applyWorkspaceLabels(activeId, { ...input, ...(redesigned ? { repropose: true } : {}), fingerprint: plan!.fingerprint, design: plan!.design });
                onOpen(`/sources?research_file=${encodeURIComponent(activeId)}`); }
            else onOpen(tabularReviewPath(await openWorkspaceTable(activeId, { ...input, fingerprint: preview!.fingerprint, design: preview!.design })));
            onClose();
        } catch (reason) { setError(errorMessage(reason, labelling
            ? "Could not apply these labels. Propose them again before trying." : "Could not create the table. Propose it again before trying.")); }
        finally { setCreating(false); }
    }
    const edit = (patch: (design: Design) => Design) => setPreview((current) => current && { ...current, design: patch(current.design) });
    const editColumn = (index: number, change: { name?: string; prompt?: string }) => edit((design) => ({ ...design,
        columns: design.columns.map((column) => column.index === index ? { ...column, ...change } : column) }));
    const removeColumn = (index: number) => edit((design) => ({ ...design,
        columns: design.columns.filter((column) => column.index !== index), cells: design.cells.filter((cell) => cell.columnIndex !== index) }));
    const addColumn = () => {
        const name = addition.trim(); if (!name) return; setAddition("");
        edit((design) => ({ ...design, columns: [...design.columns,
            { index: Math.max(-1, ...design.columns.map(({ index }) => index)) + 1, name, prompt: name, format: "text" }] }));
    };
    const filled = (index: number) => {
        const rows = new Set(preview?.design.cells.filter((cell) => cell.columnIndex === index).map(({ rowId }) => rowId)).size;
        return !rows ? "Extracted for every source" : rows >= (preview?.rows.length ?? 0) ? "From your research"
            : "Partly from your research; extracted for the rest";
    };
    const setName = (file?.document.filename ?? picked[0]?.filename ?? "").replace(/\.research\.md$/iu, "");
    const proposing = busy && (labelling ? !plan : !preview);
    const onEnter = (action: () => void) => (event: React.KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); action(); } };
    return <Modal open onClose={onClose} size="lg" breadcrumbs={[...(setName ? [setName] : []), labelling ? "Organize this research" : "Extract a table"]}
        footerStatus={error ? <p role="alert" className="me-auto text-sm text-red-700">{error}</p> : note ? <p role="status" className={`me-auto max-h-20 overflow-y-auto ${META}`}>{note}</p> : undefined}
        secondaryAction={activeId ? { label: busy ? "Proposing…" : "Propose again", disabled: busy || creating, onClick: () => void propose(adjust, true) } : undefined}
        primaryAction={activeId ? { label: creating ? "Working…" : labelling ? "Apply labels" : "Create table",
            onClick: () => void create(), disabled: busy || creating || !valid } : undefined}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 py-4">
            {!activeId ? <div className="min-h-0 flex-1"><FileDirectory selectedDocuments={picked} showTabs
                multiple={false} noun="research sets" documentFilter={isResearchDocument} onChange={setPicked}
                initialLocation={projectId ? { projectId } : { library: "files" }} /></div>
            : <>
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-1" aria-busy={busy}>
                    {proposing ? <div role="status" className="flex flex-col gap-3">
                        <p className={META}>Proposing a structure from your research…</p>
                        {[0, 1, 2].map((key) => <div key={key} className="h-20 shrink-0 animate-pulse rounded-lg bg-gray-100" />)}
                    </div>
                    : labelling ? plan && <>
                        <input aria-label="Workspace name" value={name} className={`${FIELD} ${HEAD}`} onChange={(event) => setProposedName(event.target.value)} />
                        <ul className="flex min-w-0 flex-col gap-3">{plan.labels.map((label) => <li key={label.key} className={CARD}>
                        <p className={HEAD}><span aria-hidden className="me-2 inline-block size-2.5 rounded-full"
                            style={{ background: label.color ?? "#cbd5e1" }} />{label.path} <span className={META}>{label.existing ? "Existing" : "New"}</span></p>
                        {!!label.definition && <p className="mt-1 text-sm text-gray-700">{label.definition}</p>}
                        <ul className="mt-2 space-y-1">{label.rows.map((row) => <li key={row.id} className="text-sm text-gray-700">{row.title}</li>)}</ul>
                    </li>)}
                        {!!plan.unassigned.length && <li className={META}>Not filed: {plan.unassigned.map(({ title }) => title).join(", ")}</li>}</ul></>
                    : preview && <>
                        <input aria-label="Table name" value={preview.design.title} className={`${FIELD} ${HEAD}`}
                            onChange={(event) => edit((design) => ({ ...design, title: event.target.value }))} />
                        <ul className="flex min-w-0 flex-col gap-3">{columns.map((column) => <li key={column.index} className={CARD}>
                            <input aria-label={`Column name ${column.index + 1}`} value={column.name} className={`${FIELD} ${HEAD}`}
                                onChange={(event) => editColumn(column.index, { name: event.target.value })} />
                            <input aria-label={`Column question ${column.index + 1}`} value={column.prompt} className={`mt-1 ${FIELD} text-sm text-gray-700`}
                                onChange={(event) => editColumn(column.index, { prompt: event.target.value })} />
                            <p className={`mt-2 ${META}`}>{preview.stats.find(stat => stat.index === column.index)?.existing ? "Existing" : "New"} · {filled(column.index)}</p>
                            <Button type="button" variant="ghost" size="icon-sm" aria-label={`Remove column ${column.name || column.index + 1}`}
                                className="absolute end-2 top-2 text-gray-500" onClick={() => removeColumn(column.index)}><X aria-hidden className="size-3.5" /></Button>
                        </li>)}</ul>
                        <input aria-label="Add a column" value={addition} placeholder="Add a column, e.g. Outcome" className={INPUT}
                            disabled={busy || creating} onChange={(event) => setAddition(event.target.value)} onKeyDown={onEnter(addColumn)} />
                    </>}
                </div>
                {!tableId && <label className="flex shrink-0 flex-col gap-1">
                    <span className={META}>Change the proposal</span>
                    <input value={adjust} disabled={busy || creating} className={INPUT} onChange={(event) => setAdjust(event.target.value)}
                        onKeyDown={onEnter(() => void propose(adjust, true))}
                        placeholder={labelling ? "e.g. group by the stage of the analysis" : "e.g. one column per Grant factor"} />
                </label>}
            </>}
        </div>
    </Modal>;
}
