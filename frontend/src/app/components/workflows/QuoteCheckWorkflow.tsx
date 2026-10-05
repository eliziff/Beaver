import { useRef, useState } from "react";
import { Button } from "@/app/components/ui/button";
import { Modal } from "@/app/components/modals/Modal";
import { FileDirectory, type DirectoryLocation } from "@/app/components/shared/FileDirectory";
import { type Document, directoryResource, downloadDocument } from "@/app/lib/api/documents";

import { streamQuoteCheck } from "@/app/lib/api/workflows";
import { downloadBlob } from "@/app/lib/download";
import { readSseData } from "@/app/lib/sse";
import type { WorkflowDocument } from "./ContextualWorkflowPicker";

type Report = { counts: Record<string, number>; quotes: Array<{
  id: string; quote: string; status: string; detail: string; context: string;
  candidates: Array<{ id: string; citation: string }>; receipt: null | { text: string };
}> };
type Workbook = Pick<Document, "id" | "filename" | "current_version_id">;
const eligible = (document: WorkflowDocument) => document.library_kind !== "template" && /\.(docx|pdf)$/iu.test(document.filename);
const EMPTY: WorkflowDocument[] = [];

export default function QuoteCheckWorkflow({ documents = EMPTY }: { documents?: WorkflowDocument[] }) {
  const initial = documents.length === 1 && eligible(documents[0]) ? documents[0] : null;
  const [source, setSource] = useState<WorkflowDocument | null>(initial);
  const [picker, setPicker] = useState(false);
  const [selected, setSelected] = useState<Document[]>([]);
  const [location, setLocation] = useState<DirectoryLocation>(initial?.project_id ? { projectId: initial.project_id } : { library: "files" });
  const [report, setReport] = useState<Report | null>(null);
  const [workbook, setWorkbook] = useState<Workbook | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function check(document: WorkflowDocument) {
    setBusy(true); setError(""); setReport(null); setWorkbook(null); setSource(document);
    setProgress("Reading quotations and resolving cited passages…");
    try {
      const response = await streamQuoteCheck(document.id, document.current_version_id);
      if (!response.body) throw new Error("Quotation results were unavailable.");
      const partial: Report = { quotes: [], counts: {} };
      let complete = false;
      for await (const data of readSseData(response.body)) {
        const event = JSON.parse(data);
        if (event.error) {
          if (event.workbook?.id) {
            setWorkbook(event.workbook); setProgress("Partial workbook saved beside the source document.");
          }
          throw new Error(event.error);
        }
        if (event.quote) {
          partial.quotes.push(event.quote);
          partial.counts[event.quote.status] = (partial.counts[event.quote.status] ?? 0) + 1;
          setProgress(`Checked ${event.completed} of ${event.total} quotations`);
        }
        if (event.done) {
          complete = true;
          if (!event.workbook?.id) throw new Error("The results were checked, but the workbook could not be saved.");
          setWorkbook(event.workbook); setProgress("Workbook saved beside the source document.");
        }
        setReport({ quotes: [...partial.quotes], counts: { ...partial.counts } });
      }
      if (!complete) throw new Error("The check was interrupted. The results below are incomplete; run the check again to save a workbook.");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Quotation checking failed."); }
    finally { setBusy(false); }
  }
  async function upload(file: File) {
    if (!/\.(docx|pdf)$/iu.test(file.name)) { setError("Choose a Word or PDF document."); return; }
    setBusy(true); setError(""); setProgress("Saving the source document…");
    try {
      const scope = "projectId" in location && location.projectId ? { projectId: location.projectId } : { library: "files" as const };
      const document = await directoryResource(scope).uploadDocument(file,
        (source?.project_id ?? null) === ("projectId" in scope ? scope.projectId : null) ? source?.folder_id : undefined);
      setPicker(false); await check(document);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "The source could not be saved."); }
    finally { setBusy(false); }
  }
  async function download() {
    if (!workbook) return;
    setDownloading(true); setError("");
    try { const { blob, filename } = await downloadDocument(workbook.id, workbook.current_version_id); downloadBlob(blob, filename ?? workbook.filename); }
    catch { setError("The workbook could not be downloaded. Try again."); }
    finally { setDownloading(false); }
  }
  return <div className="space-y-5 pb-5">
    <p className="text-sm leading-6 text-gray-600">Compare quotations with their cited sources without AI. The Excel workbook records wording checks, source passages, and items needing review, and is saved beside your document.</p>
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <p className="mb-3 break-all text-sm font-medium">{source?.filename ?? "Choose a Word or PDF document"}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => setPicker(true)}>Choose document</Button>
        <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>Upload document</Button>
        <Button disabled={busy || !source} onClick={() => source && void check(source)}>{busy ? "Checking…" : "Check quotations"}</Button>
      </div>
    </div>
    <input ref={input} type="file" accept=".docx,.pdf" className="sr-only" aria-label="Upload document to check" disabled={busy}
      onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.target.value = ""; }} />
    <p role="status" className="text-sm text-gray-600">{progress}</p>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    {workbook && <div className="rounded-lg border border-gray-200 p-4">
      <p className="text-xs font-semibold text-gray-500">Saved workbook</p>
      <button type="button" disabled={downloading} onClick={() => void download()}
        className="mt-2 min-h-9 break-all text-left text-sm font-medium text-gray-900 underline underline-offset-4 focus-visible:outline-2 disabled:opacity-50">
        {downloading ? "Downloading…" : workbook.filename}
      </button>
    </div>}
    {report && <p className="text-sm">{report.quotes.length} quotations · {Object.entries(report.counts).map(([status, count]) => `${count} ${status.replaceAll("_", " ")}`).join(" · ")}</p>}
    {report?.quotes.map((row) => <article key={row.id} className="space-y-2 border-t border-gray-200 py-3 text-sm">
      <p className="font-medium capitalize">{row.status.replaceAll("_", " ")}</p>
      <blockquote className="whitespace-pre-wrap border-l-2 pl-3">{row.quote}</blockquote>
      <p className="text-gray-600">{row.detail}</p>
      {row.candidates.length > 0 && <p>{row.candidates.map((item) => item.citation).join("; ")}</p>}
      <details><summary className="cursor-pointer">Document context</summary><p className="mt-2 whitespace-pre-wrap">{row.context}</p></details>
      {row.receipt && <details><summary className="cursor-pointer">Source passage</summary><p className="mt-2 whitespace-pre-wrap">{row.receipt.text}</p></details>}
    </article>)}
    {report && !report.quotes.length && !busy && !error && <p className="text-sm">No marked quotations were detected.</p>}
    <Modal open={picker} onClose={() => setPicker(false)} size="2xl" breadcrumbs={["Choose document"]}
      primaryAction={{ label: "Use document", disabled: selected.length !== 1 || busy,
        onClick: () => { const document = selected[0]; setSource(document); setReport(null); setWorkbook(null); setProgress(""); setError("");
          setLocation(document.project_id ? { projectId: document.project_id } : { library: "files" }); setPicker(false); } }}>
      {picker && <FileDirectory showTabs tabs={[["files", "Files"], ["projects", "Projects"]]}
        initialTab={source?.project_id ? "projects" : "files"} multiple={false}
        selectedDocuments={selected} onChange={setSelected} documentFilter={eligible} onLocationChange={setLocation} />}
    </Modal>
  </div>;
}
