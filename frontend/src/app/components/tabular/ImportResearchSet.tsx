import { useEffect, useRef, useState } from "react";
import { applyWorkspaceLabels, getResearchFile, openWorkspaceTable, previewWorkspaceLabels, previewWorkspaceTable,
    type ResearchLabelProposal, type ResearchTablePreview, type ResearchTableInput } from "@/app/lib/api/researchFiles";
import { isResearchDocument, researchLabelPath, type ResearchFile, type ResearchSelection } from "@/app/lib/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import { errorMessage } from "@/app/lib/utils";
import { Modal } from "../modals/Modal";
import { FileDirectory } from "../shared/FileDirectory";
import { tabularReviewPath } from "./tabularReviewRoute";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";

const HEAD = "text-sm font-semibold text-gray-900", META = "text-xs text-gray-500";
const CARD = "min-w-0 break-words rounded-lg border border-gray-200 p-4", PICKED = "border-red-700 bg-red-50/60";
const FIELD = "block w-full min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-gray-200";
type Props = { open: boolean; onClose: () => void; fileId?: string; projectId?: string | null; mode?: "table" | "labels";
    selection?: ResearchSelection; chatId?: string; messageIds?: string[]; defaultRequest?: string; onOpen: (path: string) => void };
export const ImportResearchSet = ({ open, ...props }: Props) => open ? <OpenImportResearchSet {...props} /> : null;
function OpenImportResearchSet({ onClose, fileId, projectId, selection, chatId, messageIds, onOpen,
    mode = "table", defaultRequest = "" }: Omit<Props, "open">) {
    const labelling = mode === "labels";
    const [picked, setPicked] = useState<Document[]>([]), [file, setFile] = useState<ResearchFile | null>(null);
    const [typeId, setTypeId] = useState("");
    const [preview, setPreview] = useState<ResearchTablePreview | null>(null), [request, setRequest] = useState(defaultRequest);
    const [plan, setPlan] = useState<ResearchLabelProposal | null>(null);
    const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
    const generation = useRef(0), activeId = fileId ?? picked[0]?.id, [model] = useSelectedModel();
    const input: ResearchTableInput = { ...(typeId ? { labelId: typeId } : {}),
        ...(selection ? { selection } : {}), ...(chatId ? { chatId, messageIds } : {}) };
    const inputKey = JSON.stringify(input);
    useEffect(() => {
        // The preview is replaced, never blanked, so narrowing the rows never empties the dialog.
        const run = ++generation.current;
        setPlan(null); setFile((file) => file?.document.id === activeId ? file : null); setError("");
        if (!activeId) return void setLoading(false);
        setLoading(true);
        void Promise.all([getResearchFile(activeId), labelling ? null : previewWorkspaceTable(activeId, JSON.parse(inputKey))])
            .then(([file, result]) => { if (run === generation.current) { setFile(file); setPreview(result); } })
            .catch((reason) => { if (run === generation.current) setError(errorMessage(reason, "Could not read this research")); })
            .finally(() => { if (run === generation.current) setLoading(false); });
        return () => { generation.current++; };
    }, [activeId, inputKey, labelling]);
    async function propose() {
        if (!activeId || busy || !request.trim()) return;
        const run = generation.current; setBusy(true); setError("");
        try {
            const body = { ...input, request: request.trim(), model };
            const next = await (labelling ? previewWorkspaceLabels(activeId, body) : previewWorkspaceTable(activeId, body));
            if (run !== generation.current) return;
            if (labelling) setPlan(next as ResearchLabelProposal); else setPreview(next as ResearchTablePreview);
        } catch (reason) { if (run === generation.current) setError(errorMessage(reason, labelling
            ? "Could not propose labels; nothing was changed"
            : "Could not propose columns; the current ones are unchanged")); }
        finally { setBusy(false); }
    }
    async function create() {
        if (!activeId || busy || loading || (labelling ? !plan : !preview)) return;
        setBusy(true); setError("");
        try {
            if (labelling) { await applyWorkspaceLabels(activeId, { ...input, fingerprint: plan!.fingerprint, design: plan!.design });
                onOpen(`/sources?research_file=${encodeURIComponent(activeId)}`);
            } else onOpen(tabularReviewPath(await openWorkspaceTable(activeId,
                { ...input, fingerprint: preview!.fingerprint, design: preview!.design })));
            onClose();
        } catch (reason) { setError(errorMessage(reason, labelling
            ? "Could not apply these labels. Propose them again before trying."
            : "Could not create the table. Propose the columns again before trying.")); }
        finally { setBusy(false); }
    }
    const types = Object.values(file?.state.labels ?? {}).filter(({ scope }) => scope === "highlight");
    const setName = (file?.document.filename ?? picked[0]?.filename ?? "").replace(/\.research\.md$/iu, "");
    const columns = preview?.design.columns ?? [], count = preview?.rows.length ?? 0;
    const editColumn = (index: number, patch: { name?: string; prompt?: string }) => setPreview((current) => current && ({ ...current,
        design: { ...current.design, columns: current.design.columns.map((c) => c.index === index ? { ...c, ...patch } : c) } }));
    const plural = (value: number, noun: string) => `${value} ${noun}${value === 1 ? "" : "s"}`;
    return <Modal open onClose={onClose} size="lg" breadcrumbs={[...(setName ? [setName] : []),
        labelling ? "Organize this research" : "Extract a table"]}
        footerStatus={error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        secondaryAction={{ label: labelling ? "Propose labels" : "Propose columns", disabled: busy || loading || !request.trim(),
            onClick: () => void propose() }}
        primaryAction={{ label: busy ? "Working…" : labelling ? "Apply labels" : "Create table",
            onClick: () => void create(), disabled: busy || loading || (labelling ? !plan : !preview) }}>
        <div className="flex min-h-0 flex-1 flex-col gap-5 py-4">
            {!activeId ? <div className="min-h-0 flex-1"><FileDirectory selectedDocuments={picked} showTabs
                multiple={false} noun="research sets" documentFilter={isResearchDocument} onChange={(next) => { setTypeId(""); setPicked(next); }}
                initialLocation={projectId ? { projectId } : { library: "files" }} /></div>
            : <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-5 overflow-y-auto">
                <p className="shrink-0 text-sm text-gray-700">{labelling
                    ? "Every source in this research is filed under the labels you propose below."
                    : <><span className="font-semibold text-gray-900">{plural(count, "source")}</span> as rows,{" "}
                        <span className="font-semibold text-gray-900">{plural(columns.length, "column")}</span> from your labels,
                        saved passages and research questions{loading ? " · updating…" : ""}. Beaver extracts anything a source has not answered yet.</>}</p>
                {!!types.length && <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className={META}>Rows</span>
                    {[{ id: "", name: "Every source" }, ...types.map(({ id }) =>
                        ({ id, name: researchLabelPath(file!.state.labels, id).map(({ name }) => name).join(" › ") }))].map(({ id, name }) =>
                        <button key={id} type="button" aria-pressed={typeId === id} disabled={busy} onClick={() => setTypeId(id)}
                            className={`rounded-full border px-3 py-1 text-sm ${typeId === id ? `${PICKED} text-red-800` : "border-gray-200 text-gray-700"}`}>{name}</button>)}
                </div>}
                <div className="flex shrink-0 min-w-0 flex-col gap-2">
                    <label className={HEAD} htmlFor="import-question">{labelling
                        ? "What should these be sorted into?" : "Ask for extra columns"}</label>
                    <textarea id="import-question" value={request} rows={2} disabled={busy}
                        onChange={(event) => { setRequest(event.target.value); setPlan(null); }}
                        className="w-full min-w-0 rounded-lg border border-gray-300 bg-white p-3 text-sm text-gray-900"
                        placeholder={labelling ? "The cases that state the test, grouped by how they applied it."
                            : "The outcome, the test applied, and the wording that mattered."} />
                </div>
                {labelling ? <ul className="flex min-w-0 flex-col gap-4">{plan?.labels.map((label) => <li key={label.key} className={CARD}>
                        <p className={HEAD}><span aria-hidden className="me-2 inline-block size-2.5 rounded-full"
                            style={{ background: label.color ?? "#cbd5e1" }} />{label.path}</p>
                        {!!label.definition && <p className="mt-1 text-sm text-gray-700">{label.definition}</p>}
                        <ul className="mt-3 space-y-1">{label.rows.map((row) => <li key={row.id} className="text-sm text-gray-700">{row.title}
                            {row.support.map((text, index) => <span key={index} className={`mt-1 block border-s-2 border-gray-200 ps-2 ${META}`}>{text}</span>)}</li>)}</ul>
                    </li>)}</ul>
                : <div className="flex min-w-0 flex-col gap-2"><p className={HEAD}>Columns</p>
                    <ul className="flex min-w-0 flex-col gap-3">{columns.map((column) => <li key={column.index} className={CARD}>
                        <input aria-label={`Column name ${column.index + 1}`} value={column.name} className={`${FIELD} ${HEAD}`}
                            onChange={(event) => editColumn(column.index, { name: event.target.value })} />
                        <input aria-label={`Column question ${column.index + 1}`} value={column.prompt} className={`mt-1 ${FIELD} text-sm text-gray-700`}
                            onChange={(event) => editColumn(column.index, { prompt: event.target.value })} />
                        <p className={`mt-2 ${META}`}>{preview?.samples.find((cell) => cell.columnIndex === column.index)?.text
                            ? `e.g. ${preview.samples.find((cell) => cell.columnIndex === column.index)!.text}` : "Extracted for every source"}</p>
                    </li>)}</ul></div>}
            </div>}
        </div>
    </Modal>;
}
