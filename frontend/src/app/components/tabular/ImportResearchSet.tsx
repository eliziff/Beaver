import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { applyWorkspaceLabels, getResearchFile, openWorkspaceTable, proposeWorkspaceLabels, proposeWorkspaceTable,
    type ProposalProgress, type ResearchLabelProposal, type ResearchTablePreview, type ResearchTableInput } from "@/app/lib/api/researchFiles";
import { isResearchDocument, type ResearchFile, type ResearchSelection } from "@/app/lib/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import { errorMessage } from "@/app/lib/utils";
import { Button } from "../ui/button";
import { Modal } from "../modals/Modal";
import { FileDirectory } from "../shared/FileDirectory";
import { ResearchLabelTree } from "../legal/ResearchLabelTree";
import { SourcesWorkspace } from "../legal/SourcesWorkspace";
import { tabularReviewPath } from "./tabularReviewRoute";
import { useSelectedModel, useSelectedReasoningEffort } from "@/app/hooks/useSelectedModel";
import { ActivityDisclosure } from "../assistant/message/EventBlocks";
import { ResearchProposalEditor } from "../legal/ResearchProposalEditor";

const HEAD = "text-sm font-semibold text-gray-900", META = "text-xs text-gray-500";
const CARD = "relative min-w-0 break-words rounded-lg border border-gray-200 p-4 pe-10";
const FIELD = "block w-full min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-gray-200 focus:border-gray-300";
const INPUT = "w-full min-w-0 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900";
type Props = { open: boolean; onClose: () => void; fileId?: string; projectId?: string | null; mode?: "table" | "labels";
    selection?: ResearchSelection; chatId?: string; conversationId?: string; tableId?: string; columnIndex?: number; defaultRequest?: string; onOpen: (path: string) => void;
    /** The chat composer's current selection; the global picker is the fallback. */
    model?: string | null; reasoningEffort?: string | null };
type Design = ResearchTablePreview["design"];
export const ImportResearchSet = ({ open, ...props }: Props) => open ? <OpenImportResearchSet {...props} /> : null;
/** One organizing step in either direction: the model proposes the structure from the research; the user edits it before it exists. */
function OpenImportResearchSet({ onClose, fileId, projectId, selection, chatId, conversationId, tableId, columnIndex, onOpen,
    mode = "table", defaultRequest = "", model: chatModel, reasoningEffort: chatEffort }: Omit<Props, "open">) {
    const labelling = mode === "labels";
    const [picked, setPicked] = useState<Document[]>([]), [file, setFile] = useState<ResearchFile | null>(null);
    const [preview, setPreview] = useState<ResearchTablePreview | null>(null), [plan, setPlan] = useState<ResearchLabelProposal | null>(null);
    const [adjust, setAdjust] = useState(""), [addition, setAddition] = useState("");
    const [busy, setBusy] = useState(false), [creating, setCreating] = useState(false);
    const [error, setError] = useState(""), [note, setNote] = useState("");
    // The step is launched by the user, never on opening; while it runs the modal shows what the model is doing.
    const [progress, setProgress] = useState<ProposalProgress | null>(null), [started, setStarted] = useState(0), [now, setNow] = useState(0);
    const generation = useRef(0), running = useRef<AbortController | null>(null), activeId = fileId ?? picked[0]?.id,
        [pickerModel] = useSelectedModel(), [pickerEffort] = useSelectedReasoningEffort();
    // The chat's own model first; if its provider fails, one retry on the picker's model.
    const [lane, setLane] = useState<"chat" | "picker">(chatModel ? "chat" : "picker");
    // Accept the proposal on the reading that produced it: a redesign is not re-filed under the existing ontology.
    const [redesigned, setRedesigned] = useState(false);
    const savedDesign = useRef("");
    const laneModel = (which: "chat" | "picker") => which === "chat" && chatModel
        ? { model: chatModel, effort: chatEffort ?? undefined } : { model: pickerModel, effort: pickerEffort };
    const existingStructure = labelling && file?.document.id === activeId && Object.keys(file.state.labels).length > 0;
    useEffect(() => {
        let active = true; setFile(null);
        if (labelling && activeId) void getResearchFile(activeId).then((current) => { if (active) setFile(current); })
            .catch((reason) => { if (active) setError(errorMessage(reason, "Could not load the current structure")); });
        return () => { active = false; };
    }, [activeId, labelling]);
    const input: ResearchTableInput = { ...(selection ? { selection } : {}), ...(chatId ? { chatId } : {}),
        ...(conversationId && labelling ? { conversationId } : {}), ...(tableId ? { tableId, columnIndex } : {}) };
    const inputKey = JSON.stringify(input);
    async function propose(instruction = "", repropose = false, which = lane) {
        if (!activeId) return;
        running.current?.abort(); const controller = new AbortController(); running.current = controller;
        const run = ++generation.current, { model, effort } = laneModel(which);
        setBusy(true); setError(""); setNote(""); setProgress({ stage: "reading" }); setStarted(Date.now()); setNow(Date.now());
        try {
            const request = [defaultRequest.trim(), instruction.trim()].filter(Boolean).join("\n");
            const body = { ...JSON.parse(inputKey) as Omit<ResearchTableInput, "design">, ...(request ? { request } : {}), ...(repropose ? { repropose } : {}), model,
                ...(labelling && plan ? { proposalId: plan.proposalId, currentDesign: plan.design } : {}),
                ...(effort ? { reasoningEffort: effort } : {}) };
            const report = (event: ProposalProgress) => { if (run === generation.current) setProgress(event); };
            const [current, next] = await Promise.all([getResearchFile(activeId), labelling
                ? proposeWorkspaceLabels(activeId, body, report, controller.signal) : proposeWorkspaceTable(activeId, body, report, controller.signal)]);
            if (run !== generation.current) return;
            setFile(current); setRedesigned(repropose || (labelling && !!(next as ResearchLabelProposal).reproposed));
            if (labelling) { setPlan(next as ResearchLabelProposal); savedDesign.current = JSON.stringify((next as ResearchLabelProposal).design); }
            else { setPreview(next as ResearchTablePreview); setNote((next as ResearchTablePreview).fallback ?? ""); }
        } catch (reason) { if (run !== generation.current || controller.signal.aborted) return;
            if (which === "chat" && chatModel && pickerModel && pickerModel !== chatModel) { setLane("picker"); return propose(instruction, repropose, "picker"); }
            setError(errorMessage(reason, labelling
            ? "Could not generate label suggestions; nothing was changed" : "Could not generate a table; nothing was changed")); }
        finally { if (run === generation.current) { setBusy(false); setProgress(null); } }
    }
    const cancel = () => { running.current?.abort(); generation.current++; setBusy(false); setProgress(null); };
    useEffect(() => { setPreview(null); setPlan(null); setBusy(false); setProgress(null); setError("");
        return () => { generation.current++; running.current?.abort(); }; }, [activeId, inputKey, labelling]);
    useEffect(() => { if (!busy) return; const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [busy]);
    const elapsed = started ? Math.max(0, Math.round((now - started) / 1000)) : 0;
    const working = progress?.stage === "reading" ? "Reading research…"
        : progress?.stage === "asking" ? ["Generating suggestions…",
            progress.chars ? `${progress.chars.toLocaleString()} characters` : "", `${elapsed} s`].filter(Boolean).join(" · ")
        : progress?.stage === "checking" ? "Checking the draft against the research…"
        : progress?.stage === "retrying" ? "Preparing another suggestion…" : "";
    const columns = preview?.design.columns ?? [];
    const valid = labelling ? !!plan : columns.length > 0 && columns.every((column) => column.name.trim() && column.prompt.trim());
    async function create() {
        if (!activeId || creating || busy || !valid) return;
        setCreating(true); setError("");
        try {
            if (labelling) { await applyWorkspaceLabels(activeId, { ...input, ...(redesigned ? { repropose: true } : {}),
                ...(plan!.proposalId ? { proposalId: plan!.proposalId } : {}), fingerprint: plan!.fingerprint, design: plan!.design });
                onOpen(`/sources?research_file=${encodeURIComponent(activeId)}`); }
            else onOpen(tabularReviewPath(await openWorkspaceTable(activeId, { ...input, fingerprint: preview!.fingerprint, design: preview!.design })));
            onClose();
        } catch (reason) { setError(errorMessage(reason, labelling
            ? "Could not apply these labels. Try suggesting them again." : "Could not create the table. Try suggesting a new table.")); }
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
    const proposed = labelling ? !!plan : !!preview;
    async function close() {
        if (labelling && plan?.proposalId && activeId && JSON.stringify(plan.design) !== savedDesign.current) {
            if (busy || creating) return;
            setCreating(true); setError("");
            try { await proposeWorkspaceLabels(activeId, { ...input, proposalId: plan.proposalId,
                fingerprint: plan.fingerprint, design: plan.design }, () => undefined); }
            catch (reason) { setError(errorMessage(reason, "Could not save your draft")); return; }
            finally { setCreating(false); }
        }
        onClose();
    }
    const onEnter = (action: () => void) => (event: React.KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); action(); } };
    return <Modal open onClose={() => void close()} size="lg" breadcrumbs={[...(setName ? [setName] : []), labelling ? "Organize research" : "Create a table"]}
        footerStatus={error ? <p role="alert" className="me-auto text-sm text-red-700">{error}</p>
            : note ? <p role="status" className={`me-auto max-h-20 overflow-y-auto ${META}`}>{note}</p> : undefined}
        secondaryAction={!activeId ? undefined : busy ? { label: "Cancel", onClick: cancel }
            : proposed ? { label: "Suggest again", disabled: creating, onClick: () => void propose(adjust, true) }
            : existingStructure ? { label: "Open workspace", onClick: () => { onOpen(`/sources?research_file=${encodeURIComponent(activeId)}`); onClose(); } } : undefined}
        primaryAction={!activeId ? undefined : busy ? { label: "Generating suggestions…", disabled: true }
            : !proposed ? { label: existingStructure ? "Suggest changes" : labelling ? "Suggest labels" : "Suggest a table", onClick: () => void propose(adjust, existingStructure || !!adjust.trim()) }
            : { label: creating ? labelling ? "Applying labels…" : "Creating table…" : labelling ? "Apply labels" : "Create table", onClick: () => void create(), disabled: creating || !valid }}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 py-4">
            {!activeId ? <div className="min-h-0 flex-1"><FileDirectory selectedDocuments={picked} showTabs
                multiple={false} noun="research sets" documentFilter={isResearchDocument} onChange={setPicked}
                initialLocation={projectId ? { projectId } : { library: "files" }} /></div>
            : <>
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-1" aria-busy={busy}>
                    {busy && <ActivityDisclosure isStreaming label={working} />}
                    {busy && !proposed ? null
                    : !proposed ? <div className="flex flex-col gap-2">
                        {existingStructure && file && <>
                            <h2 className={HEAD}>Current structure</h2>
                            <SourcesWorkspace file={file}>{([["Labels", "source"], ["Highlight types", "highlight"]] as const)
                                .filter(([, scope]) => Object.values(file.state.labels).some((label) => label.scope === scope))
                                .map(([heading, scope]) => <section key={scope}>
                                    <h3 className={META}>{heading}</h3>
                                    <ResearchLabelTree scope={scope} selectedId={null} onSelect={() => undefined}
                                        onRemove={() => undefined} onStatus={() => undefined} preview={{ labels: file.state.labels, marks: {} }} />
                                </section>)}</SourcesWorkspace>
                        </>}
                        <p className="text-sm text-gray-700">{labelling
                            ? existingStructure ? "Review the suggested changes, then apply them." : "Suggest labels and highlight types for this workspace. Review them before applying the changes."
                            : "Review the suggested table before creating it. Each row represents a source; edit the columns to capture what you need."}</p>
                    </div>
                    : labelling ? plan && <>
                        <ResearchProposalEditor proposal={{ sources: plan.sources, items: plan.items }} design={plan.design} disabled={busy || creating}
                            onChange={(design) => setPlan({ ...plan, design })} />
                    </>
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
                    <span className={META}>{proposed
                        ? labelling ? "Adjust the labels" : "Adjust the table"
                        : labelling ? "How should we group the research? (optional)" : "What should the table include? (optional)"}</span>
                    <input value={adjust} disabled={busy || creating} className={INPUT} onChange={(event) => setAdjust(event.target.value)}
                        onKeyDown={onEnter(() => void propose(adjust, proposed || !!adjust.trim()))}
                        placeholder={labelling ? "e.g. group by analysis stage" : "e.g. one column for each Grant factor"} />
                </label>}
            </>}
        </div>
    </Modal>;
}
