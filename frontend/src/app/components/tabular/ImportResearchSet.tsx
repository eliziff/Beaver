import { useEffect, useRef, useState, type ReactNode } from "react";
import { getResearchFile, openWorkspaceTable, previewResearchTable, type ResearchTablePlan,
    type ResearchImportColumn, type ResearchTableInput } from "@/app/lib/api/researchFiles";
import { isResearchDocument, researchLabelPath, type ResearchFile, type ResearchSelection } from "@/app/lib/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import type { TabularReview } from "@/app/lib/api/tabular";
import { errorMessage } from "@/app/lib/utils";
import { Modal } from "../modals/Modal";
import { FileDirectory } from "../shared/FileDirectory";
import { Button } from "../ui/button";
import { tabularReviewPath } from "./tabularReviewRoute";

type Props = { open: boolean; onClose: () => void; fileId?: string; projectId?: string | null;
    scopeControl?: ReactNode; selection?: ResearchSelection; chatId?: string; messageIds?: string[];
    replaceTable?: TabularReview; onApplied?: () => void; onOpen: (path: string) => void };
const inputClass = "w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm";
export function ImportResearchSet({ open, ...props }: Props) {
    return open ? <OpenImportResearchSet {...props} /> : null;
}
function OpenImportResearchSet({ onClose, fileId, projectId, selection, scopeControl, chatId, messageIds, replaceTable, onApplied, onOpen }: Omit<Props, "open">) {
    const [picked, setPicked] = useState<Document[]>([]), [file, setFile] = useState<ResearchFile | null>(null);
    const [rows, setRows] = useState<"sources" | "passages">(replaceTable?.scope_config?.researchImport?.rows ?? "sources"), [type, setType] = useState(replaceTable?.scope_config?.researchImport?.labelId ?? "");
    const [plan, setPlan] = useState<ResearchTablePlan | null>(null), [columns, setColumns] = useState<ResearchImportColumn[]>([]);
    const [title, setTitle] = useState(""), [request, setRequest] = useState(""), [dirty, setDirty] = useState(false);
    const [busy, setBusy] = useState(false), [error, setError] = useState("");
    const activeId = fileId ?? picked[0]?.id, task = useRef<AbortController | null>(null);
    const [from, setFrom] = useState(""), [fieldFilter, setFieldFilter] = useState("");
    const chosenScope: ResearchSelection | undefined = from === "all" ? { target: "sources" } : from ? { target: "sources", labelIds: [from] } : selection;
    const base: ResearchTableInput = { rows, ...(type ? { labelId: type } : {}), selection: chosenScope, chatId, messageIds,
        ...(replaceTable ? { replaceTableId: replaceTable.id, expectedVersion: replaceTable.updated_at, columns: replaceTable.scope_config?.researchImport?.columns } : {}) };
    const baseKey = JSON.stringify(base);
    async function preview(input: ResearchTableInput, reset = false) {
        task.current?.abort(); const controller = new AbortController(); task.current = controller;
        if (!activeId) return;
        setBusy(true); setError("");
        if (reset) { setPlan(null); setColumns([]); }
        try {
            const next = await previewResearchTable(activeId, input, controller.signal);
            if (controller.signal.aborted) return;
            setPlan(next); setColumns(next.columns); setTitle(next.title); setDirty(false);
        } catch (reason) { if (!controller.signal.aborted) setError(errorMessage(reason, "Could not preview this research")); }
        finally { if (!controller.signal.aborted) setBusy(false); }
    }
    useEffect(() => {
        if (!activeId) return;
        let active = true;
        void getResearchFile(activeId).then((next) => { if (active) setFile(next); })
            .catch((reason) => { if (active) setError(errorMessage(reason, "Could not load research")); });
        return () => { active = false; };
    }, [activeId]);
    useEffect(() => { void preview(JSON.parse(baseKey), true); return () => task.current?.abort(); }, [activeId, baseKey]);
    function edit(index: number, values: Partial<ResearchImportColumn>) {
        setColumns((current) => current.map((column) => column.index === index ? { ...column, ...values } : column)); setDirty(true);
    }
    async function create() {
        if (!activeId || !plan || busy || dirty) return;
        setBusy(true); setError("");
        try {
            const review = await openWorkspaceTable(activeId, { ...base, columns, title, basis: plan.basis });
            onApplied?.(); onOpen(tabularReviewPath(review)); onClose();
        } catch (reason) { setError(errorMessage(reason, "Could not apply this review. Refresh the preview and try again.")); }
        finally { setBusy(false); }
    }
    return <Modal open onClose={onClose} size="2xl" breadcrumbs={[replaceTable ? "Refresh from research" : "Review existing research"]}
        footerStatus={error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        primaryAction={{ label: replaceTable ? "Propose update" : "Create review", onClick: () => void create(),
            disabled: !plan?.arrangement.rows.length || !columns.length || !title.trim() || busy || dirty }}>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-3">
            {!fileId && <FileDirectory selectedDocuments={picked} onChange={setPicked} showTabs multiple={false} noun="research sets"
                documentFilter={isResearchDocument} initialLocation={projectId ? { projectId } : { library: "files" }} />}
            {scopeControl}
            {activeId && <>
                {error && <Button size="compact" variant="outline" disabled={busy} onClick={() => void preview({ ...base, columns: undefined }, true)}>Rebuild preview from available research</Button>}
                <div className="flex flex-wrap items-center gap-3 text-sm">
                    {!chatId && <select aria-label="Research scope" value={from} disabled={busy} onChange={(event) => setFrom(event.target.value)} className="max-w-64 rounded border border-gray-300 p-1">
                        <option value="">Current selection</option><option value="all">All research sources</option>
                        {Object.values(file?.state.labels ?? {}).filter(({ scope }) => scope === "source").map(({ id }) =>
                            <option key={id} value={id}>{researchLabelPath(file!.state.labels, id).map(({ name }) => name).join(" › ")}</option>)}
                    </select>}
                    <label>Rows <select aria-label="Review rows" value={rows} disabled={busy} onChange={(event) => setRows(event.target.value as typeof rows)} className="rounded border border-gray-300 p-1">
                        <option value="sources">Sources</option><option value="passages">Saved passages</option></select></label>
                    <select aria-label="Highlight type filter" value={type} disabled={busy} onChange={(event) => setType(event.target.value)} className="max-w-64 rounded border border-gray-300 p-1">
                        <option value="">All highlight types</option>{Object.values(file?.state.labels ?? {}).filter(({ scope }) => scope === "highlight").map(({ id }) =>
                            <option key={id} value={id}>{researchLabelPath(file!.state.labels, id).map(({ name }) => name).join(" › ")}</option>)}</select>
                    {plan && <span className="text-gray-500">{plan.arrangement.rows.length} rows</span>}
                </div>
                {busy && <p role="status" className="text-sm text-gray-500">Preparing preview…</p>}
                {plan && <>
                    <input aria-label="Review title" value={title} onChange={(event) => setTitle(event.target.value)} className={`${inputClass} font-medium`} />
                    <div className="divide-y divide-gray-200">{columns.map((column) => {
                        const reuse = plan.reuse.find(({ index }) => index === column.index);
                        return <details key={column.index} className="py-2">
                            <summary className="cursor-pointer text-sm"><span className="font-medium">{column.name}</span>
                                <span className="ml-2 text-gray-500">{dirty ? "Preview changes" : `${reuse?.reused ?? 0} reused · ${reuse?.unrun ?? plan.arrangement.rows.length} unrun`}</span></summary>
                            <div className="space-y-2 pt-2">
                                <input aria-label={`Column ${column.index + 1} title`} value={column.name} onChange={(event) => edit(column.index, { name: event.target.value })} className={inputClass} />
                                <textarea aria-label={`Prompt for ${column.name}`} value={column.prompt} onChange={(event) => edit(column.index, { prompt: event.target.value })} className={inputClass} rows={2} />
                                <fieldset className="space-y-1"><legend className="text-xs text-gray-500">Reuse existing work; leave unchecked for new extraction</legend>
                                    {plan.fields.length > 12 && <input aria-label="Filter reusable fields" placeholder="Find existing work…" value={fieldFilter} onChange={(event) => setFieldFilter(event.target.value)} className={inputClass} />}
                                    {plan.fields.filter((field) => !fieldFilter || field.name.toLowerCase().includes(fieldFilter.toLowerCase())).map((field) => <label key={field.id} className="flex items-start gap-2 text-sm">
                                        <input type="checkbox" checked={column.fieldIds.includes(field.id)} onChange={(event) => edit(column.index, {
                                            format: "text", tags: undefined, fieldIds: event.target.checked ? [...column.fieldIds, field.id] : column.fieldIds.filter((id) => id !== field.id) })} />
                                        <span>{field.name}<span className="ml-2 text-xs text-gray-500">{field.kind === "passages" ? "Excerpts" : field.kind === "claim" ? "Grounded claim" : field.kind} · {field.rows} rows</span></span></label>)}
                                </fieldset>
                                <Button size="compact" variant="ghost" onClick={() => { setColumns((current) => current.filter(({ index }) => index !== column.index)); setDirty(true); }}>Remove column</Button>
                            </div>
                        </details>;
                    })}</div>
                    <Button variant="ghost" size="compact" onClick={() => { setColumns((current) => [...current, {
                        index: Math.max(-1, ...current.map(({ index }) => index)) + 1, name: "New question", prompt: "What do you want to find out?", format: "text", fieldIds: [] }]); setDirty(true); }}>+ Column</Button>
                    {!!plan.preview.length && !dirty && <div className="overflow-x-auto rounded border border-gray-200" aria-label="Review preview">
                        <table className="w-full text-left text-xs"><thead><tr><th className="p-2">Source</th>{columns.map((column) => <th key={column.index} className="min-w-40 p-2">{column.name}</th>)}</tr></thead>
                            <tbody>{plan.preview.map((row, index) => <tr key={index} className="border-t border-gray-200"><th className="p-2 align-top font-medium">{row.title}</th>{row.values.map((value, at) =>
                                <td key={at} className="max-w-64 whitespace-pre-wrap p-2 align-top">{value || <span className="text-gray-500">Not run</span>}</td>)}</tr>)}</tbody></table>
                        <p className="border-t border-gray-200 p-2 text-xs text-gray-500">Preview of the first {plan.preview.length} rows. Excerpts remain quotations, not newly inferred answers.</p>
                    </div>}
                    {replaceTable && <p className="text-sm text-gray-600">This proposes a new snapshot. Review it in Changes before accepting; existing results are not silently replaced.</p>}
                </>}
                <details><summary className="cursor-pointer text-sm">Suggest a different review</summary>
                    <div className="space-y-2 pt-2"><textarea aria-label="What to compare" value={request} onChange={(event) => setRequest(event.target.value)}
                        placeholder="Compare why each clause was valid or invalid, reusing my existing classifications and passages." rows={2} className={inputClass} />
                        <Button variant="outline" size="compact" disabled={busy || !request.trim()} onClick={() => void preview({ ...base, title: title || undefined, columns: plan ? columns : undefined, request })}>Suggest columns</Button></div>
                </details>
                <Button variant="outline" size="compact" disabled={busy || columns.some(({ name, prompt }) => !name.trim() || !prompt.trim())} onClick={() =>
                    void preview({ ...base, title: title || undefined, columns: plan ? columns : undefined })}>{dirty ? "Update preview" : "Refresh preview"}</Button>
            </>}
        </div>
    </Modal>;
}
