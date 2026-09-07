import { useEffect, useRef, useState } from "react";
import { getResearchFile, openWorkspaceTable, previewWorkspaceTable,
    type ResearchTablePreview, type ResearchTableInput } from "@/app/lib/api/researchFiles";
import { isResearchDocument, researchLabelPath, type ResearchFile, type ResearchSelection } from "@/app/lib/researchFiles";
import type { Document } from "@/app/lib/api/documents";
import { errorMessage } from "@/app/lib/utils";
import { Modal } from "../modals/Modal";
import { FormField } from "../modals/ModalFieldLabel";
import { ModalSelect } from "../modals/ModalSelect";
import { FileDirectory } from "../shared/FileDirectory";
import { Button } from "../ui/button";
import { tabularReviewPath } from "./tabularReviewRoute";

type Props = { open: boolean; onClose: () => void; fileId?: string; projectId?: string | null;
    selection?: ResearchSelection; chatId?: string; messageIds?: string[]; onOpen: (path: string) => void };
export function ImportResearchSet({ open, ...props }: Props) {
    return open ? <OpenImportResearchSet {...props} /> : null;
}
function OpenImportResearchSet({ onClose, fileId, projectId, selection, chatId, messageIds, onOpen }: Omit<Props, "open">) {
    const [picked, setPicked] = useState<Document[]>([]), [file, setFile] = useState<ResearchFile | null>(null);
    const [rows, setRows] = useState<"sources" | "passages">("sources"), [typeId, setTypeId] = useState("");
    const [preview, setPreview] = useState<ResearchTablePreview | null>(null), [request, setRequest] = useState("");
    const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
    const generation = useRef(0), activeId = fileId ?? picked[0]?.id;
    const input: ResearchTableInput = { rows, ...(typeId ? { labelId: typeId } : {}),
        ...(selection ? { selection } : {}), ...(chatId ? { chatId, messageIds } : {}) };
    const inputKey = JSON.stringify(input);
    useEffect(() => {
        const run = ++generation.current;
        setPreview(null); setFile((file) => file?.document.id === activeId ? file : null); setError("");
        if (!activeId) { setLoading(false); return; }
        setLoading(true);
        void Promise.all([getResearchFile(activeId), previewWorkspaceTable(activeId, JSON.parse(inputKey))])
            .then(([file, result]) => { if (run === generation.current) { setFile(file); setPreview(result); } })
            .catch((reason) => { if (run === generation.current) setError(errorMessage(reason, "Could not preview this research")); })
            .finally(() => { if (run === generation.current) setLoading(false); });
        return () => { generation.current++; };
    }, [activeId, inputKey]);
    async function suggest() {
        if (!activeId || busy || !request.trim()) return;
        const run = generation.current;
        setBusy(true); setError("");
        try { const next = await previewWorkspaceTable(activeId, { ...input, request: request.trim() });
            if (run === generation.current) setPreview(next);
        } catch (reason) { if (run === generation.current) setError(errorMessage(reason, "Could not suggest a layout; the current preview is unchanged")); }
        finally { setBusy(false); }
    }
    async function create() {
        if (!activeId || !preview || busy || loading) return;
        setBusy(true); setError("");
        try {
            const review = await openWorkspaceTable(activeId, { ...input, fingerprint: preview.fingerprint, design: preview.design });
            onOpen(tabularReviewPath(review)); onClose();
        } catch (reason) { setError(errorMessage(reason, "Could not create the review. Refresh the preview before trying again.")); }
        finally { setBusy(false); }
    }
    const types = Object.values(file?.state.labels ?? {}).filter(({ scope }) => scope === "highlight");
    const reused = preview?.stats.reduce((sum, { reused }) => sum + reused, 0) ?? 0;
    return <Modal open onClose={onClose} size="2xl" breadcrumbs={["Review this research"]}
        footerStatus={error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        primaryAction={{ label: busy ? "Working…" : "Open review", onClick: () => void create(), disabled: !preview || busy || loading }}>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-3">
            {!fileId && <div className="min-h-40"><FileDirectory selectedDocuments={picked} onChange={(next) => { setTypeId(""); setPicked(next); }}
                showTabs multiple={false} noun="research sets" documentFilter={isResearchDocument}
                initialLocation={projectId ? { projectId } : { library: "files" }} /></div>}
            {activeId && <>
                <div className="flex flex-wrap items-end gap-3">
                    <FormField label="Rows" htmlFor="import-rows"><ModalSelect id="import-rows" value={rows} disabled={busy}
                        options={[{ value: "sources", label: "Sources" }, { value: "passages", label: "Saved passages" }]}
                        onChange={(value) => setRows(value as typeof rows)} /></FormField>
                    {!!types.length && <FormField label="Highlight type" htmlFor="import-type"><ModalSelect id="import-type" value={typeId} disabled={busy}
                        options={[{ value: "", label: "All types" }, ...types.map(({ id }) => ({ value: id,
                            label: researchLabelPath(file!.state.labels, id).map(({ name }) => name).join(" › ") }))]}
                        onChange={setTypeId} /></FormField>}
                </div>
                {loading && <p role="status" className="text-sm text-gray-500">Preparing existing research…</p>}
                {preview && <>
                    <p className="text-sm text-gray-600">{preview.rows.length} rows · {reused} populated cells · {preview.rows.length * preview.design.columns.length - reused} unanswered</p>
                    <div role="region" aria-label="Existing research preview" tabIndex={0}
                        className="shrink-0 overflow-x-auto rounded border border-gray-200">
                        <table aria-label="Conversion preview" className="w-full text-left text-xs">
                            <thead><tr><th className="min-w-40 p-2">Source</th>{preview.design.columns.map((column) => {
                                const stat = preview.stats.find(({ index }) => index === column.index)!;
                                return <th key={column.index} className="min-w-44 p-2 align-top"><details><summary className="cursor-pointer">{column.name}</summary><p className="mt-1 max-w-72 whitespace-normal font-normal text-gray-600">{column.prompt}</p></details>
                                    <span className="mt-1 block font-normal text-gray-500">{stat.reused ? `${stat.reused} reused · ${stat.kinds.join(", ")}` : "New question"}</span></th>;
                            })}</tr></thead>
                            <tbody>{preview.rows.slice(0, 3).map((row) => <tr key={row.id} className="border-t border-gray-200">
                                <th className="p-2 align-top font-medium">{row.title}</th>{preview.design.columns.map(({ index }) => <td key={index} className="p-2 align-top">
                                    {preview.samples.find((cell) => cell.rowId === row.id && cell.columnIndex === index)?.text || <span className="text-gray-400">Not answered</span>}
                                </td>)}</tr>)}</tbody>
                        </table>
                    </div>
                    {preview.rows.length > 3 && <p className="text-xs text-gray-500">Showing 3 of {preview.rows.length} rows. All are included.</p>}
                    <p className="text-xs text-gray-500">Reused passages stay excerpts; new questions still need extraction. Later research edits will not rewrite this review.</p>
                </>}
                <FormField label="What would you like to compare?" htmlFor="import-question">
                    <textarea id="import-question" value={request} onChange={(event) => setRequest(event.target.value)} rows={2}
                        className="w-full rounded border border-gray-300 bg-white p-2 text-sm" placeholder="Compare the outcome, reasons, and wording that mattered." />
                </FormField>
                <div className="flex gap-2"><Button size="compact" variant="outline" onClick={() => void suggest()} disabled={busy || loading || !request.trim()}>
                    Suggest layout</Button><Button size="compact" variant="ghost" disabled={busy || loading} onClick={() => {
                        const run = ++generation.current; setLoading(true); setError("");
                        void previewWorkspaceTable(activeId, input).then((next) => { if (run === generation.current) setPreview(next); })
                            .catch((reason) => { if (run === generation.current) setError(errorMessage(reason, "Could not refresh the preview")); })
                            .finally(() => { if (run === generation.current) setLoading(false); });
                    }}>Refresh preview</Button></div>
            </>}
        </div>
    </Modal>;
}
