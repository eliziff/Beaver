import { useEffect, useState } from "react";
import { Modal } from "../modals/Modal";
import { cancelUpload, listUploads, resumeUpload, retryUpload, uploadDocumentSession, type UploadSession } from "@/app/lib/api/uploads";

export function UploadsModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<UploadSession[] | null>(null), [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let active = true, pending = false;
    const refresh = async () => {
      if (pending) return; pending = true;
      try { const next = await listUploads(); if (active) setRows(next); }
      catch (error) { if (active) setError(error instanceof Error ? error.message : "Could not load uploads."); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    window.addEventListener("beaver-uploads-changed", refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("beaver-uploads-changed", refresh); };
  }, []);
  const run = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id); setError(null);
    try { await action(); setRows(await listUploads()); }
    catch (error) { setError(error instanceof Error ? error.message : "Upload failed."); }
    finally { setBusy(null); }
  };
  return <Modal open fit onClose={onClose} breadcrumbs={["Uploads"]}>
    {error && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{error}</p>}
    {!rows ? <p role="status">Loading uploads...</p> : !rows.length ? <p>No uploads in the last 24 hours.</p>
      : <ul className="divide-y divide-gray-200 dark:divide-gray-700">{rows.map((row) => <li key={row.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
        <div className="min-w-0 flex-1"><p className="break-words">{row.filename}</p>
          <p role="status" className="text-xs text-gray-500 dark:text-gray-400">{row.status === "pending" ? busy === row.id ? "Uploading..." : "Needs the original file" : row.status === "queued" ? "Processing" : row.status === "complete" ? "Uploaded" : row.error ?? row.status}</p></div>
        {(row.status === "pending" || row.status === "failed" && !row.retryable) && <label className="text-xs">
          Select file<input aria-label={`Select original file for ${row.filename}`} type="file" disabled={!!busy}
            className="block max-w-48 text-xs" onChange={(event) => {
              const file = event.target.files?.[0]; event.target.value = "";
              if (file) void run(row.id, () => row.status === "pending" ? resumeUpload(row, file) : uploadDocumentSession(file, {
                project_id: row.project_id, folder_id: row.folder_id, library_kind: row.library_kind,
              }));
            }} /></label>}
        {row.retryable && <button type="button" aria-label={`Retry ${row.filename}`} disabled={!!busy} onClick={() => void run(row.id, () => retryUpload(row.id))}>Retry</button>}
        {["pending", "queued"].includes(row.status) && <button type="button" aria-label={`Cancel ${row.filename}`}
          onClick={() => void run(row.id, () => cancelUpload(row.id))}>Cancel</button>}
      </li>)}</ul>}
  </Modal>;
}
