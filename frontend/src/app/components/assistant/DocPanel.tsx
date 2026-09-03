import { lazy, Suspense, useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { ContextualWorkflowLauncher } from "../workflows/ContextualWorkflowPicker";
import type { WorkflowDocument } from "../workflows/ContextualWorkflowPicker";
import type {
  Citation,
  EditAnnotation,
  EditResolveHandlers,
} from "../shared/types";
import {
  expandCitationToEntries,
  getDocumentCitationQuotes,
  isDocxFilename,
  isSpreadsheetFilename,
} from "../shared/types";
import { DocumentViewer } from "../shared/views/DocumentViewer";
import { Button } from "../ui/button";
import { downloadDocument, getResearchFile } from "../../lib/beaverApi";
import { downloadBlob } from "../../lib/download";
import { useEditResolution } from "./EditCard";
import type { ResearchFile } from "../../lib/researchFiles";

const ResearchFileBar = lazy(async () => ({
  default: (await import("../legal/ResearchFileBar")).ResearchFileBar,
}));

function ResearchDocument({ documentId, projectId }: { documentId: string; projectId?: string }) {
  const [file, setFile] = useState<ResearchFile | null>(null);
  useEffect(() => { void getResearchFile(documentId).then(setFile); }, [documentId]);
  return file ? <Suspense fallback={null}><ResearchFileBar file={file} projectId={projectId}
    onChange={setFile} /></Suspense> : <div role="status" className="m-auto text-sm text-gray-500">Loading research…</div>;
}

export type DocPanelMode =
  | { kind: "document" }
  | { kind: "citation"; citation: Citation }
  | ({
      kind: "edit";
      edit: EditAnnotation;
      focusKey: number;
      isEditReloading?: boolean;
    } & EditResolveHandlers);

export function DocPanel({
  documentId,
  filename,
  projectId,
  versionId,
  versionNumber,
  mode,
  isReloading = false,
  warning,
  onWarningDismiss,
  initialScrollTop,
  onScrollChange,
  onOpenWorkflows,
}: {
  documentId: string;
  filename: string;
  projectId?: string;
  versionId: string | null;
  versionNumber: number | null;
  mode: DocPanelMode;
  isReloading?: boolean;
  warning?: string | null;
  onWarningDismiss?: () => void;
  initialScrollTop?: number | null;
  onScrollChange?: (scrollTop: number) => void;
  onOpenWorkflows?: (documents: WorkflowDocument[]) => void;
}) {
  const [version, setVersion] = useState({ source: versionId, value: versionId });
  const [downloading, setDownloading] = useState(false);
  const activeVersion = version.source === versionId ? version.value : versionId;
  const documentQuotes = mode.kind === "citation"
    ? getDocumentCitationQuotes(mode.citation)
    : undefined;
  const editHighlight = mode.kind === "edit" ? {
    key: `${mode.edit.edit_id}:${mode.focusKey}`,
    inserted_text: mode.edit.inserted_text,
    deleted_text: mode.edit.deleted_text,
    ins_w_id: mode.edit.ins_w_id ?? null,
    del_w_id: mode.edit.del_w_id ?? null,
  } : null;

  async function download() {
    if (downloading || isReloading) return;
    setDownloading(true);
    try {
      const result = await downloadDocument(documentId, activeVersion);
      downloadBlob(result.blob, result.filename ?? filename);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      {mode.kind === "edit" ? (
        <EditActions mode={mode} />
      ) : (
        <header className="flex items-center gap-3 px-3 py-3">
          <h2 className="min-w-0 flex-1 truncate font-serif text-xl" title={filename}>
            {filename}
            {!!versionNumber && <small className="ml-2 font-sans text-xs">V{versionNumber}</small>}
          </h2>
          <ContextualWorkflowLauncher
            documents={[{ id: documentId, filename, project_id: projectId }]}
            onOpen={onOpenWorkflows}
            onDocumentChanged={(result) => setVersion({
              source: versionId,
              value: result.version_id,
            })}
          />
          <Button variant="outline" size="compact" onClick={() => void download()} disabled={downloading || isReloading}>
            {downloading || isReloading
              ? <Loader2 className="size-3.5 animate-spin" />
              : <Download className="size-3.5" />}
            Download
          </Button>
        </header>
      )}
      <div className="flex min-h-0 flex-1 flex-col p-3">
        {filename.toLowerCase().endsWith(".research.md") ? <ResearchDocument
          documentId={documentId} projectId={projectId} /> : <DocumentViewer
          documentId={documentId}
          kind={isDocxFilename(filename)
            ? "docx"
            : isSpreadsheetFilename(filename) ? "spreadsheet" : "pdf"}
          versionId={activeVersion}
          quotes={mode.kind === "citation"
            ? expandCitationToEntries(mode.citation)
            : undefined}
          highlightEdit={editHighlight}
          highlightCells={documentQuotes
            ?.filter(({ cell, sheet }) => cell || sheet)
            .map(({ cell, sheet }) => ({ cell, sheet }))}
          warning={warning ?? null}
          onWarningDismiss={onWarningDismiss}
          initialScrollTop={initialScrollTop ?? null}
          onScrollChange={onScrollChange}
        />}
      </div>
    </div>
  );
}

function EditActions({ mode }: { mode: Extract<DocPanelMode, { kind: "edit" }> }) {
  const { edit, isEditReloading, ...handlers } = mode;
  const { status, resolve, disabled } = useEditResolution(
    edit,
    undefined,
    isEditReloading,
    handlers,
  );
  return (
    <header className="flex justify-end gap-2 border-b p-2">
      <Button size="compact" onClick={() => resolve("accept")} disabled={disabled}>
        {status === "accepted" ? "Accepted" : "Accept"}
      </Button>
      <Button variant="outline" size="compact" onClick={() => resolve("reject")} disabled={disabled}>
        {status === "rejected" ? "Rejected" : "Reject"}
      </Button>
    </header>
  );
}
