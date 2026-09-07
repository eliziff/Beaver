import { useEffect, useRef, useState } from "react";
import { applyWorkspaceLabels, getResearchFile, openWorkspaceTable, previewWorkspaceLabels, previewWorkspaceTable,
    type ResearchLabelProposal, type ResearchTablePreview, type ResearchTableInput } from "@/app/lib/api/researchFiles";
import { isResearchDocument, researchLabelPath, type ResearchFile, type ResearchSelection } from "@/app/lib/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import { errorMessage } from "@/app/lib/utils";
import { Modal } from "../modals/Modal";
import { FileDirectory } from "../shared/FileDirectory";
import { Button } from "../ui/button";
import { tabularReviewPath } from "./tabularReviewRoute";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";

const HEAD = "text-sm font-semibold text-gray-900", META = "text-xs text-gray-500";
const CARD = "min-w-0 break-words rounded-lg border border-gray-200 p-4", PICKED = "border-red-700 bg-red-50/60";
const PANE = "flex min-h-0 w-full min-w-0 flex-1 flex-col gap-6 overflow-y-auto";
const FIELD = "block w-full min-w-0 rounded border border-transparent bg-transparent px-1 py-0.5 hover:border-gray-200";
const ROWS = [["sources", "Sources", "One row for each source in this research."],
    ["passages", "Saved passages", "One row for each passage you highlighted."]] as const;
type Props = { open: boolean; onClose: () => void; fileId?: string; projectId?: string | null; mode?: "table" | "labels";
    selection?: ResearchSelection; chatId?: string; messageIds?: string[]; defaultRequest?: string; onOpen: (path: string) => void };
export const ImportResearchSet = ({ open, ...props }: Props) => open ? <OpenImportResearchSet {...props} /> : null;
function OpenImportResearchSet({ onClose, fileId, projectId, selection, chatId, messageIds, onOpen,
    mode = "table", defaultRequest = "" }: Omit<Props, "open">) {
    const labelling = mode === "labels";
    const [picked, setPicked] = useState<Document[]>([]), [file, setFile] = useState<ResearchFile | null>(null);
    const [rows, setRows] = useState<"sources" | "passages">("sources"), [typeId, setTypeId] = useState("");
    const [preview, setPreview] = useState<ResearchTablePreview | null>(null), [request, setRequest] = useState(defaultRequest);
    const [plan, setPlan] = useState<ResearchLabelProposal | null>(null), [at, setAt] = useState(0);
    const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
    const generation = useRef(0), activeId = fileId ?? picked[0]?.id, [model] = useSelectedModel();
    const steps = [...(fileId ? [] : ["Choose research"]), "What to include",
        labelling ? "What to sort by" : "Shape the table", labelling ? "Review labels" : "Review"], step = steps[at];
    const last = at === steps.length - 1;
    const input: ResearchTableInput = { rows, ...(typeId ? { labelId: typeId } : {}),
        ...(selection ? { selection } : {}), ...(chatId ? { chatId, messageIds } : {}) };
    const inputKey = JSON.stringify(input);
    useEffect(() => {
        const run = ++generation.current;
        setPreview(null); setPlan(null); setFile((file) => file?.document.id === activeId ? file : null); setError("");
        if (!activeId) return void setLoading(false);
        setLoading(true);
        void Promise.all([getResearchFile(activeId), labelling ? null : previewWorkspaceTable(activeId, JSON.parse(inputKey))])
            .then(([file, result]) => { if (run === generation.current) { setFile(file); setPreview(result); } })
            .catch((reason) => { if (run === generation.current) setError(errorMessage(reason, "Could not read this research")); })
            .finally(() => { if (run === generation.current) setLoading(false); });
        return () => { generation.current++; };
    }, [activeId, inputKey, labelling]);
    async function suggest() {
        if (!activeId || busy || !request.trim()) return false;
        const run = generation.current; setBusy(true); setError("");
        try {
            const body = { ...input, request: request.trim(), model };
            const next = await (labelling ? previewWorkspaceLabels(activeId, body) : previewWorkspaceTable(activeId, body));
            if (run !== generation.current) return false;
            if (labelling) setPlan(next as ResearchLabelProposal); else setPreview(next as ResearchTablePreview);
            return true;
        } catch (reason) { if (run === generation.current) setError(errorMessage(reason,
            labelling ? "Could not propose labels; nothing was changed" : "Could not suggest a layout; the current preview is unchanged"));
            return false; }
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
            : "Could not create the review. Refresh the preview before trying again.")); }
        finally { setBusy(false); }
    }
    async function advance() {
        if (last) return void create();
        if (!labelling || step !== "What to sort by" || await suggest()) setAt(at + 1);
    }
    const types = Object.values(file?.state.labels ?? {}).filter(({ scope }) => scope === "highlight");
    const setName = (file?.document.filename ?? picked[0]?.filename ?? "").replace(/\.research\.md$/iu, "");
    const columns = preview?.design.columns ?? [];
    const editColumn = (index: number, patch: { name?: string; prompt?: string }) => setPreview((current) => current && ({ ...current,
        design: { ...current.design, columns: current.design.columns.map((c) => c.index === index ? { ...c, ...patch } : c) } }));
    const ready = step === "Choose research" ? !!activeId : step === "What to include" ? labelling || !!preview
        : step === "What to sort by" ? !!request.trim() : labelling ? !!plan : !!preview;
    return <Modal open onClose={onClose} size="lg" breadcrumbs={[...(setName ? [setName] : []),
        labelling ? "Organize this research" : "Review this research"]}
        footerStatus={error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        cancelAction={at > 0 && { label: "Back", disabled: busy, onClick: () => setAt(at - 1) }}
        primaryAction={{ label: busy ? "Working…" : last ? (labelling ? "Apply labels" : "Create review") : "Next",
            onClick: () => void advance(), disabled: busy || loading || !ready }}>
        <div className="flex min-h-0 flex-1 flex-col gap-6 py-4">
            <div className="flex shrink-0 items-center gap-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-red-700">{step}</p>
                <span aria-hidden className="flex flex-1 gap-1">{steps.map((name, index) => <span key={name}
                    className={`h-0.5 flex-1 rounded-full ${index <= at ? "bg-red-700" : "bg-gray-200"}`} />)}</span></div>
            {step === "Choose research" ? <div className="min-h-0 flex-1"><FileDirectory selectedDocuments={picked} showTabs
                multiple={false} noun="research sets" documentFilter={isResearchDocument} onChange={(next) => { setTypeId(""); setPicked(next); }}
                initialLocation={projectId ? { projectId } : { library: "files" }} /></div>
            : step === "What to include" ? <div className={PANE}>
                {ROWS.map(([value, title, hint]) => <button key={value} type="button" aria-pressed={rows === value} disabled={busy}
                    onClick={() => setRows(value)} className={`${CARD} text-left ${rows === value ? PICKED : "hover:border-gray-300"}`}>
                    <span className={`block ${HEAD}`}>{title}</span><span className={`mt-1 block ${META}`}>{hint}</span></button>)}
                {!!types.length && <div className="flex flex-col gap-4"><p className={HEAD}>Highlight types</p>
                    <div className="flex flex-wrap gap-2">{[{ id: "", name: "All types" }, ...types.map(({ id }) =>
                        ({ id, name: researchLabelPath(file!.state.labels, id).map(({ name }) => name).join(" › ") }))].map(({ id, name }) =>
                        <button key={id} type="button" aria-pressed={typeId === id} disabled={busy} onClick={() => setTypeId(id)}
                            className={`rounded-full border px-3 py-1 text-sm ${typeId === id ? `${PICKED} text-red-800` : "border-gray-200 text-gray-700"}`}>{name}</button>)}</div>
                </div>}
                {loading && <p role="status" className={META}>Preparing existing research…</p>}
            </div>
            : !last ? <div className={PANE}>
                <div className="flex min-w-0 flex-col gap-4">
                    <label className={HEAD} htmlFor="import-question">{labelling
                        ? "What should these be sorted into?" : "What would you like to compare?"}</label>
                    <textarea id="import-question" value={request} rows={3} disabled={busy}
                        onChange={(event) => { setRequest(event.target.value); setPlan(null); }}
                        className="w-full min-w-0 rounded-lg border border-gray-300 bg-white p-3 text-sm text-gray-900"
                        placeholder={labelling ? "The cases that state the test, grouped by how they applied it."
                            : "Compare the outcome, reasons, and wording that mattered."} />
                    {!labelling && <div className="flex justify-end"><Button size="compact" variant="outline"
                        onClick={() => void suggest()} disabled={busy || loading || !request.trim()}>Suggest layout</Button></div>}
                </div>
                {!labelling && <div className="flex min-w-0 flex-col gap-4"><p className={HEAD}>Columns</p>
                    <ul className="flex min-w-0 flex-col gap-4">{columns.map((column) => <li key={column.index} className={CARD}>
                        <input aria-label={`Column name ${column.index + 1}`} value={column.name} className={`${FIELD} ${HEAD}`}
                            onChange={(event) => editColumn(column.index, { name: event.target.value })} />
                        <input aria-label={`Column question ${column.index + 1}`} value={column.prompt} className={`mt-1 ${FIELD} text-sm text-gray-700`}
                            onChange={(event) => editColumn(column.index, { prompt: event.target.value })} />
                    </li>)}</ul></div>}
            </div>
            : <ul className={`${PANE} gap-4`}>
                {labelling ? plan?.labels.map((label) => <li key={label.key} className={CARD}>
                    <p className={HEAD}><span aria-hidden className="me-2 inline-block size-2.5 rounded-full"
                        style={{ background: label.color ?? "#cbd5e1" }} />{label.path}</p>
                    {!!label.definition && <p className="mt-1 text-sm text-gray-700">{label.definition}</p>}
                    <ul className="mt-3 space-y-1">{label.rows.map((row) => <li key={row.id} className="text-sm text-gray-700">{row.title}
                        {row.support.map((text, index) => <span key={index} className={`mt-1 block border-s-2 border-gray-200 ps-2 ${META}`}>{text}</span>)}</li>)}</ul>
                </li>)
                : preview?.rows.map((row) => <li key={row.id} className={CARD}>
                    <p className={HEAD}>{row.title}</p>
                    <dl className="mt-3 flex min-w-0 flex-col gap-3">{columns.map((column) => <div key={column.index} className="min-w-0">
                        <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">{column.name}</dt>
                        <dd className="mt-1 text-sm text-gray-700">{preview.samples.find((cell) =>
                            cell.rowId === row.id && cell.columnIndex === column.index)?.text
                            || <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">will be extracted</span>}</dd>
                    </div>)}</dl></li>)}
            </ul>}
        </div>
    </Modal>;
}
