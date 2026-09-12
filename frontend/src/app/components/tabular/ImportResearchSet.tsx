import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { applyWorkspaceLabels, getResearchFile, openWorkspaceTable, proposeWorkspaceLabels, proposeWorkspaceTable,
    type ProposalProgress, type ResearchLabelProposal, type ResearchTablePreview, type ResearchTableInput } from "@/app/lib/api/researchFiles";
import { isResearchDocument, type ResearchFile, type ResearchLabel, type ResearchSelection, type ResearchSource } from "@/app/lib/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import { errorMessage } from "@/app/lib/utils";
import { Button } from "../ui/button";
import { Modal } from "../modals/Modal";
import { FileDirectory } from "../shared/FileDirectory";
import { ResearchTree, type ResearchTreePreview } from "../legal/ResearchTree";
import { SourcesWorkspace } from "../legal/SourcesWorkspace";
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
/** The proposed ontology as the tree it would create: the workspace's own labels, the proposed ones marked,
 *  each filed source under its label and, beneath a source, the passages the filing rests on. */
function proposedTree(plan: ResearchLabelProposal, file: ResearchFile | null) {
    const labels: Record<string, ResearchLabel> = { ...file?.state.labels }, marks: ResearchTreePreview["marks"] = {};
    const passages: NonNullable<ResearchTreePreview["passages"]> = {}, sources: Record<string, ResearchSource> = {}, quoted = new Set<string>();
    // A passage row is one source's row; a source row is its own. Either way the source carries the filing.
    const source = (rowId: string) => {
        const id = rowId.includes(":") ? rowId.slice(0, rowId.indexOf(":")) : rowId, saved = file?.state.sources[id];
        return saved ? sources[id] ??= { ...saved, labelIds: [],
            passages: { count: 0, sha256: "", unlabelledCount: 0, labelCounts: {} } } : null;
    };
    const order = (label: { scope: ResearchLabel["scope"] }) => label.scope === "highlight" ? 0 : 1;
    // Highlight types first: the passages they name are the ones the filings then rest on.
    for (const label of [...plan.labels].sort((first, second) => order(first) - order(second))) {
        labels[label.id] = label;
        if (!label.existing) marks[label.id] = "added";
        for (const row of label.rows) {
            const item = source(row.id); if (!item) continue;
            if (label.scope === "source") { item.labelIds.push(label.id); marks[item.id] = "changed"; }
            for (const quote of row.support) {
                const key = `${item.id} ${quote}`; if (quoted.has(key)) continue;
                quoted.add(key); (passages[item.id] ??= []).push({ labelId: label.id, quote });
                if (label.scope === "highlight") item.passages!.labelCounts[label.id] = (item.passages!.labelCounts[label.id] ?? 0) + 1;
            }
        }
    }
    for (const row of plan.unassigned) source(row.id);
    return { sources: Object.values(sources), preview: { labels, marks, passages } };
}
/** One organizing step in either direction: the model proposes the structure from the research; the user edits it before it exists. */
function OpenImportResearchSet({ onClose, fileId, projectId, selection, chatId, tableId, columnIndex, onOpen,
    mode = "table", defaultRequest = "", model: chatModel, reasoningEffort: chatEffort }: Omit<Props, "open">) {
    const labelling = mode === "labels";
    const [picked, setPicked] = useState<Document[]>([]), [file, setFile] = useState<ResearchFile | null>(null);
    const [preview, setPreview] = useState<ResearchTablePreview | null>(null), [plan, setPlan] = useState<ResearchLabelProposal | null>(null);
    const [adjust, setAdjust] = useState(""), [addition, setAddition] = useState(""), [name, setProposedName] = useState("");
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
    const laneModel = (which: "chat" | "picker") => which === "chat" && chatModel
        ? { model: chatModel, effort: chatEffort ?? undefined } : { model: pickerModel, effort: pickerEffort };
    const { model, effort } = laneModel(lane);
    const input: ResearchTableInput = { ...(selection ? { selection } : {}), ...(chatId ? { chatId } : {}), ...(tableId ? { tableId, columnIndex } : {}) };
    const inputKey = JSON.stringify(input);
    async function propose(instruction = "", repropose = false, which = lane) {
        if (!activeId) return;
        running.current?.abort(); const controller = new AbortController(); running.current = controller;
        const run = ++generation.current, { model, effort } = laneModel(which);
        setBusy(true); setError(""); setNote(""); setProgress({ stage: "reading" }); setStarted(Date.now()); setNow(Date.now());
        try {
            const request = [defaultRequest.trim(), instruction.trim()].filter(Boolean).join("\n");
            const body = { ...JSON.parse(inputKey) as ResearchTableInput, ...(request ? { request } : {}), ...(repropose ? { repropose } : {}), model,
                ...(effort ? { reasoningEffort: effort } : {}) };
            // A rejected first attempt stays on screen through the corrected one, so the lawyer sees why it took longer.
            const report = (event: ProposalProgress) => { if (run !== generation.current) return;
                setProgress((current) => event.stage === "asking" && current?.note ? { ...event, note: current.note } : event); };
            const [current, next] = await Promise.all([getResearchFile(activeId), labelling
                ? proposeWorkspaceLabels(activeId, body, report, controller.signal) : proposeWorkspaceTable(activeId, body, report, controller.signal)]);
            if (run !== generation.current) return;
            setFile(current); setRedesigned(repropose || (labelling && !!(next as ResearchLabelProposal).reproposed));
            if (labelling) { setPlan(next as ResearchLabelProposal); setProposedName((next as ResearchLabelProposal).title); }
            else { setPreview(next as ResearchTablePreview); setNote((next as ResearchTablePreview).fallback ?? ""); }
        } catch (reason) { if (run !== generation.current || controller.signal.aborted) return;
            if (which === "chat" && chatModel && pickerModel && pickerModel !== chatModel) { setLane("picker"); return propose(instruction, repropose, "picker"); }
            setError(errorMessage(reason, labelling
            ? "Could not propose labels; nothing was changed" : "Could not propose a table; nothing was changed")); }
        finally { if (run === generation.current) { setBusy(false); setProgress(null); } }
    }
    const cancel = () => { running.current?.abort(); generation.current++; setBusy(false); setProgress(null); };
    useEffect(() => { setPreview(null); setPlan(null); setBusy(false); setProgress(null); setError("");
        return () => { generation.current++; running.current?.abort(); }; }, [activeId, inputKey, labelling]);
    useEffect(() => { if (!busy) return; const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, [busy]);
    const elapsed = started ? Math.max(0, Math.round((now - started) / 1000)) : 0, shortModel = (value = model) => value.split(":").pop() ?? value;
    const working = progress?.stage === "reading" ? "Reading the research…"
        : progress?.stage === "asking" ? [progress.note ? `Second attempt (the first was rejected: ${progress.note})` : "", `Asking ${shortModel(progress.model)}…`,
            progress.chars ? `${progress.chars.toLocaleString()} characters` : "", `${elapsed} s`].filter(Boolean).join(" · ")
        : progress?.stage === "checking" ? "Checking the proposal against the research…"
        : progress?.stage === "retrying" ? `The first proposal was rejected (${progress.note}); asking for a correction…` : "";
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
    const tree = useMemo(() => labelling && plan ? proposedTree(plan, file) : null, [labelling, plan, file]);
    // Every source of the proposal opens with it: nothing the old flat list showed waits behind a chevron.
    const [opened, setOpened] = useState<Set<string>>(() => new Set());
    useEffect(() => { if (tree) setOpened(new Set(Object.keys(tree.preview.passages))); }, [tree]);
    const setName = (file?.document.filename ?? picked[0]?.filename ?? "").replace(/\.research\.md$/iu, "");
    const proposed = labelling ? !!plan : !!preview;
    const onEnter = (action: () => void) => (event: React.KeyboardEvent) => { if (event.key === "Enter") { event.preventDefault(); action(); } };
    return <Modal open onClose={onClose} size="lg" breadcrumbs={[...(setName ? [setName] : []), labelling ? "Organize this research" : "Extract a table"]}
        footerStatus={error ? <p role="alert" className="me-auto text-sm text-red-700">{error}</p>
            : busy && proposed ? <p role="status" className={`me-auto ${META}`}>{working}</p>
            : note ? <p role="status" className={`me-auto max-h-20 overflow-y-auto ${META}`}>{note}</p> : undefined}
        secondaryAction={!activeId ? undefined : busy ? { label: "Cancel", onClick: cancel }
            : proposed ? { label: "Propose again", disabled: creating, onClick: () => void propose(adjust, true) } : undefined}
        primaryAction={!activeId ? undefined : busy ? { label: "Proposing…", disabled: true }
            : !proposed ? { label: labelling ? "Propose labels" : "Propose a table", onClick: () => void propose(adjust, !!adjust.trim()) }
            : { label: creating ? "Working…" : labelling ? "Apply labels" : "Create table", onClick: () => void create(), disabled: creating || !valid }}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 py-4">
            {!activeId ? <div className="min-h-0 flex-1"><FileDirectory selectedDocuments={picked} showTabs
                multiple={false} noun="research sets" documentFilter={isResearchDocument} onChange={setPicked}
                initialLocation={projectId ? { projectId } : { library: "files" }} /></div>
            : <>
                <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pe-1" aria-busy={busy}>
                    {busy && !proposed ? <div role="status" className="flex flex-col gap-3">
                        <p className={META}>{working}</p>
                        {[0, 1, 2].map((key) => <div key={key} className="h-20 shrink-0 animate-pulse rounded-lg bg-gray-100" />)}
                    </div>
                    : !proposed ? <div className="flex flex-col gap-2">
                        <p className="text-sm text-gray-700">{labelling
                            ? "The model reads this research's sources, saved passages and findings and proposes a label set to file them under. Nothing changes until you apply it."
                            : "The model reads this research's sources, saved passages and findings and proposes a table: one row per source, one column per thing a lawyer wants to see. Nothing is created until you accept it."}</p>
                        <p className={META}>Runs on {shortModel()}{effort ? ` · ${effort} reasoning` : ""}</p>
                    </div>
                    : labelling ? plan && tree && <>
                        <input aria-label="Workspace name" value={name} className={`${FIELD} ${HEAD}`} onChange={(event) => setProposedName(event.target.value)} />
                        {/* The proposal as the workspace it would become: labels file sources, highlight types hold the
                            passages behind each filing, and whatever stays unfiled sits at the root. */}
                        <SourcesWorkspace file={file}>{([["Labels", "source"], ["Highlight types", "highlight"]] as const)
                            .filter(([, scope]) => plan.labels.some((label) => label.scope === scope)
                                || scope === "source" && tree.sources.some(({ labelIds }) => !labelIds.length))
                            .map(([heading, scope]) => <section key={heading} className="flex min-w-0 flex-col gap-1">
                            <h3 className={META}>{heading}</h3>
                            <ResearchTree scope={scope} sources={tree.sources} preview={tree.preview} opened={opened} setOpened={setOpened} />
                        </section>)}</SourcesWorkspace></>
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
                    <span className={META}>{proposed ? "Change the proposal" : "Organization to follow (optional)"}</span>
                    <input value={adjust} disabled={busy || creating} className={INPUT} onChange={(event) => setAdjust(event.target.value)}
                        onKeyDown={onEnter(() => void propose(adjust, proposed || !!adjust.trim()))}
                        placeholder={labelling ? "e.g. group by the stage of the analysis" : "e.g. one column per Grant factor"} />
                </label>}
            </>}
        </div>
    </Modal>;
}
